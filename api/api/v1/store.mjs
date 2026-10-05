import { container } from "../shared/db.mjs";
import { bytes, digest, document, partition, recordId, MAX_RECORD_BYTES } from "./contract.mjs";
import { ValidationError } from "../shared/validate.mjs";
import { defaultSettings } from "../shared/defaults.mjs";
import { applyWorkflow } from "./workflow.mjs";
import { validateReview, validateReviewDecision } from "./reviews.mjs";
import { validateBrief } from "./briefs.mjs";

import { validateWorkspace, workspaceOf } from "./workspaces.mjs";
import { validateClarification } from './clarification.mjs';

import { normalizeMembership, memberships, isCollection, collectionContents, refKey } from './collection-model.mjs';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export async function read(accountId, id) {
  try { return (await container.item(id, partition(accountId)).read()).resource ?? null; }
  catch (error) { if (error.code === 404) return null; throw error; }
}
const create = resourceBody => ({ operationType: "Create", resourceBody });
const replace = (resourceBody, ifMatch) => ({ operationType: "Replace", id: resourceBody.id, resourceBody, ifMatch });

async function hasContents(accountId, target, pending, workspaceId = null) {
  const { resources } = await container.items.query({
    query: `SELECT TOP 21 c.record FROM c WHERE c.UserID=@u AND c.ObjectType='sync' AND c.ObjectID='v1' AND c.kind='record' AND c.record.deleted=false AND
      (ARRAY_CONTAINS(c.record.collectionRefs, @ref) OR
       (NOT IS_DEFINED(c.record.collectionRefs) AND c.record.${target.type === 'project' ? 'projectId' : 'listId'}=@l) OR
       (c.record.parentRef.type=@type AND c.record.parentRef.id=@l))`,
    parameters: [{ name: '@u', value: accountId }, { name: '@l', value: target.id }, { name: '@type', value: target.type }, { name: '@ref', value: { type: target.type, id: target.id } }]
  }, { partitionKey: partition(accountId) }).fetchAll();
  // At most 20 records can change in this operation; a 21st dependent blocks deletion or movement.
  return [...resources.map(row => row.record).filter(record => !pending.some(next => refKey(next) === refKey(record))), ...pending]
    .some(record => collectionContents(record, target) && (workspaceId === null || (record.workspaceId || 'personal') !== workspaceId));
}
async function validateCollections(record, lookup) {
  if (record.deleted) return;
  const refs = record.type === 'item' ? memberships(record) : isCollection(record) && record.parentRef ? [record.parentRef] : [];
  for (const ref of refs) {
    const target = await lookup(ref.type, ref.id);
    if (!target || target.deleted) throw new ApiError(404, `${ref.type}_not_found`, 'Destination collection is unavailable. Restore or remove its link.');
    if ((target.workspaceId || 'personal') !== (record.workspaceId || 'personal')) throw new ValidationError('Collections and items must belong to the same workspace. Clear memberships before moving.');
  }
  if (isCollection(record)) {
    let parent = record.parentRef;
    const seen = new Set([refKey(record)]);
    while (parent) {
      if (seen.has(refKey(parent))) throw new ValidationError('A collection cannot be its own ancestor.');
      seen.add(refKey(parent));
      parent = (await lookup(parent.type, parent.id))?.parentRef;
    }
  }
}

export async function commit(accountId, input, requestHash = digest(input)) {
  const receiptId = `receipt:${input.operationId}`;
  // All v1 writers serialize on the account state ETag. Reads can be stale;
  // a failed precondition retries the whole read/validate/commit decision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await read(accountId, "state");
    const previous = await read(accountId, receiptId);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new ApiError(409, "operation_reused", "Use a new operationId for different content.");
      return previous.response;
    }
    const current = await Promise.all(input.mutations.map(m => read(accountId, recordId(m.type, m.id))));
    const conflicts = input.mutations.flatMap((proposed, i) => {
      const record = current[i]?.record ?? null;
      return ((proposed.action === "restore" ? !record?.deleted : record?.deleted) || (record?.version ?? 0) !== proposed.expectedVersion)
        ? [{ proposed, current: record }] : [];
    });
    const sequence = (state?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new ApiError(503, "sequence_exhausted", "Account sequence requires maintenance.");
    const now = new Date().toISOString();
    const records = conflicts.length ? [] : input.mutations.map((m, i) => {
      const old = current[i]?.record;
      const record = { ...old, ...m.fields, id: m.id, type: m.type, accountId,
        version: m.expectedVersion + 1, createdUtc: old?.createdUtc ?? now, updatedUtc: now,
        deleted: m.action === "delete", deletedUtc: m.action === "delete" ? now : null };
      if (m.type === "item") {
        try { normalizeMembership(record, old, m.fields); } catch (error) { throw new ValidationError(error.message); }
        applyWorkflow(record, old, m.fields);
        record.completedUtc = record.status === "completed" ? (old?.completedUtc ?? now) : null;
      }
      // Review metadata keeps at most 200 references/heads; history lives in
      // individually bounded, immutable decision records.
      if (bytes(record) > (record.type === 'review' ? 65536 : MAX_RECORD_BYTES)) throw new ValidationError(
        ['review', 'reviewDecision'].includes(record.type) ? "Review save exceeds its capacity. Update the app and resume this saved review; its history is retained." : "Record exceeds the 32 KiB limit; shorten its text or links.");
      return record;
    });
    const settings = records.find(record => record.type === "settings") ?? (await read(accountId, recordId("settings", "settings")))?.record;
    const userDefaults = { ...defaultSettings, ...(settings?.defaults ?? {}) };
    const lookup = async (type, id) => records.find(r => r.type === type && r.id === id) ?? (await read(accountId, recordId(type, id)))?.record;
    for (const [i, record] of records.entries()) {
      await validateWorkspace(record, current[i]?.record, lookup);
      await validateCollections(record, lookup);
      if (record.type === 'reviewDecision') validateReviewDecision(record, current[i]?.record, records);
      if (record.type === 'brief') await validateBrief(record, current[i]?.record,
        async (type, id) => (type === 'brief' ? undefined : records.find(r => r.type === type && r.id === id)) ?? (await read(accountId, recordId(type, id)))?.record);
      if (record.type === 'review') await validateReview(record, current[i]?.record, input.mutations, records,
        async ref => {
          const target = (await read(accountId, recordId(ref.type, ref.id)))?.record;
          return target && await workspaceOf(target, lookup) === (record.workspaceId || 'personal') ? target : null;
        });
      if (record.type === "clarification") {
        const originalItem = (await read(accountId, recordId('item', record.id)))?.record;
        validateClarification(record, current[i]?.record, input.mutations, originalItem);
        const item = records.find(r => r.type === "item" && r.id === record.id)
          ?? (await read(accountId, recordId("item", record.id)))?.record;
        const trash = record.step === 'complete' && record.answers.disposition.choice === 'trash';
        if (!item || item.deleted && !trash) throw new ApiError(404, "item_not_found", "Clarification requires an existing item in this account.");
      }
      let list;
      if (record.type === "item" && !record.deleted && record.listId) {
        const pending = records.find(r => r.type === "list" && r.id === record.listId);
        list = pending ?? (await read(accountId, recordId("list", record.listId)))?.record;
        if (!list || list.deleted) throw new ApiError(404, "list_not_found", "Destination list not found in this account.");
      }
      if (record.type === "item" && !record.deleted) {
        if (record.projectId) {
          const project = records.find(r => r.type === "project" && r.id === record.projectId)
            ?? (await read(accountId, recordId("project", record.projectId)))?.record;
          if (!project || project.deleted) throw new ApiError(404, "project_not_found", "Destination project not found in this account.");
        }
        const mutation = input.mutations[i], old = current[i]?.record;
        const allowed = ["inbox", "next", "waiting", "deferred", "someday", "reference", "completed", "dropped", ...(list?.defaults?.statuses ?? userDefaults.statuses)];
        // Historic values stay editable; unrelated edits and moves never erase them.
        if (mutation.fields?.status !== undefined && ![...allowed, old?.status, old?.statusBeforeCompletion, old?.workflowBeforeTransition?.status].includes(record.status)) {
          throw new ValidationError("status is not configured for this list or account.");
        }
      }
      if (["list", "project"].includes(record.type) && record.deleted && await hasContents(accountId, record, records)) {
        throw new ApiError(409, `${record.type}_not_empty`, `Move or delete this ${record.type}'s items and unlink child collections before deleting it.`);
      }
      if (isCollection(record) && current[i]?.record && !record.deleted &&
          (record.workspaceId || 'personal') !== (current[i].record.workspaceId || 'personal') &&
          await hasContents(accountId, record, records, record.workspaceId || 'personal')) {
        throw new ValidationError('Move linked items and child collections with this collection.');
      }
    }
    const response = { apiVersion: 1, accountId, operationId: input.operationId, sequence,
      status: conflicts.length ? "conflict" : "committed", records,
      ...(conflicts.length ? { proposed: input.mutations, conflicts } : {}) };
    const nextState = document(accountId, "state", { kind: "state", sequence });
    const batch = [state ? replace(nextState, state._etag) : create(nextState),
      ...records.map((record, i) => {
        const doc = document(accountId, recordId(record.type, record.id), { kind: "record", record });
        return current[i] ? replace(doc, current[i]._etag) : create(doc);
      }),
      create(document(accountId, receiptId, { kind: "receipt", requestHash, response })),
      create(document(accountId, `change:${sequence}`, { kind: "change", sequence, response }))];
    if (bytes(batch) > 1500000) throw new ValidationError("Operation is too large; send fewer records per operation.");
    const result = await container.items.batch(batch, partition(accountId));
    const codes = [result.code, ...(result.result ?? []).map(r => r.statusCode)];
    if (codes.some(code => [409, 412].includes(code))) continue;
    if (result.code < 200 || result.code >= 300 || result.result?.length !== batch.length ||
        result.result.some(r => r.statusCode < 200 || r.statusCode >= 300)) {
      throw new ApiError(503, "storage_unavailable", "Commit was not acknowledged. Retry the same operationId and content.");
    }
    return response;
  }
  throw new ApiError(503, "account_busy", "Concurrent writes are busy. Retry the same operationId and content.");
}

export async function changes(accountId, after, limit, through) {
  const state = await read(accountId, "state");
  const visible = state?.sequence ?? 0;
  if (through !== undefined && through > visible) throw new ApiError(409, "snapshot_unavailable", "Export cutoff exceeds visible history. Retry later or start a new export.");
  const highWater = through ?? visible;
  if (after > highWater) throw new ApiError(409, "cursor_ahead", "Cursor exceeds visible account history. Keep local work and retry; check for a restored database.");
  const entries = [];
  let next = after;
  let size = 0;
  // Contiguous, immutable IDs permit bounded point reads without query tokens,
  // empty intermediate pages, timestamp ties or an offset that shifts on edits.
  while (next < highWater && entries.length < limit) {
    const row = await read(accountId, `change:${next + 1}`);
    if (!row || row.sequence !== next + 1) throw new ApiError(503, "history_gap", "History is not contiguous. Keep the current cursor and retry.");
    const length = bytes(row.response);
    if (entries.length && size + length > 1000000) break;
    entries.push(row.response); size += length; next = row.sequence;
  }
  return { apiVersion: 1, accountId, entries, nextAfter: next, highWater, hasMore: next < highWater };
}
