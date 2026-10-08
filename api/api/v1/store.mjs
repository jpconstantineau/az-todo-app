import { container } from "../shared/db.mjs";
import { bytes, digest, document, partition, recordId, MAX_RECORD_BYTES } from "./contract.mjs";
import { ValidationError } from "../shared/validate.mjs";
import { defaultSettings } from "../shared/defaults.mjs";
import { applyWorkflow } from "./workflow.mjs";
import { validateReview, validateReviewDecision, validateReviewReflection } from "./reviews.mjs";
import { validateBrief } from "./briefs.mjs";
import { validateDailyPlan, validateDailyPlanRevision } from './daily-plans.mjs';

import { validateWorkspace, workspaceOf } from "./workspaces.mjs";
import { erasedWorkspaceIds } from './workspace-erasure.mjs';
import { validateClarification } from './clarification.mjs';

import { normalizeMembership, memberships, isCollection, collectionContents, refKey } from './collection-model.mjs';
import { recurrenceAlreadySatisfied, validateRecurrence } from './recurrence.mjs';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export async function read(accountId, id) {
  try { return (await container.item(id, partition(accountId)).read()).resource ?? null; }
  catch (error) { if (error.code === 404) return null; throw error; }
}
const create = resourceBody => ({ operationType: "Create", resourceBody });
const replace = (resourceBody, ifMatch) => ({ operationType: "Replace", id: resourceBody.id, resourceBody, ifMatch });
async function hasErasureFence(accountId) {
  const { resources } = await container.items.query({
    query: "SELECT TOP 1 c.id FROM c WHERE c.UserID=@u AND c.ObjectType='sync' AND c.ObjectID='v1' AND c.kind='workspace-erasure'",
    parameters: [{ name: '@u', value: accountId }]
  }, { partitionKey: partition(accountId) }).fetchAll();
  return resources.length > 0;
}

async function hasContents(accountId, target, pending, workspaceId = null) {
  const { resources } = await container.items.query({
    query: `SELECT TOP 21 c.record FROM c WHERE c.UserID=@u AND c.ObjectType='sync' AND c.ObjectID='v1' AND c.kind='record' AND c.record.deleted=false AND
      (ARRAY_CONTAINS(c.record.collectionRefs, @ref) OR
       (c.record.parentRef.type=@type AND c.record.parentRef.id=@l))`,
    parameters: [{ name: '@u', value: accountId }, { name: '@l', value: target.id }, { name: '@type', value: target.type }, { name: '@ref', value: { type: target.type, id: target.id } }]
  }, { partitionKey: partition(accountId) }).fetchAll();
  // At most 20 records can change in this operation; a 21st dependent blocks deletion or movement.
  return [...resources.map(row => row.record).filter(record => !pending.some(next => refKey(next) === refKey(record))), ...pending]
    .some(record => collectionContents(record, target) && (workspaceId === null || record.workspaceId !== workspaceId));
}
async function archivedCollection(ref, lookup) {
  const seen = new Set();
  while (ref && !seen.has(refKey(ref))) {
    seen.add(refKey(ref));
    const collection = await lookup(ref.type, ref.id);
    if (!collection || collection.deleted) return null;
    if (collection.archived) return collection;
    ref = collection.parentRef;
  }
  return null;
}
async function validateCollections(record, old, lookup) {
  if (record.deleted) return;
  const refs = ['item', 'recurrenceTemplate'].includes(record.type) ? memberships(record) : isCollection(record) && record.parentRef ? [record.parentRef] : [];
  const retained = new Set(['item', 'recurrenceTemplate'].includes(record.type) ? memberships(old).map(refKey) : old?.parentRef ? [refKey(old.parentRef)] : []);
  for (const ref of refs) {
    const target = await lookup(ref.type, ref.id);
    if (!target || target.deleted) throw new ApiError(404, `${ref.type}_not_found`, 'Destination collection is unavailable. Restore or remove its link.');
    if (target.workspaceId !== record.workspaceId) throw new ValidationError('Collections and items must belong to the same workspace. Clear memberships before moving.');
    if (!retained.has(refKey(ref)) && await archivedCollection(ref, lookup)) throw new ValidationError('Archived collections cannot receive new items or child collections. Reactivate it or choose an active destination.');
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
function validateCurrentShape(record) {
  if (['item', 'list', 'project', 'savedView', 'review', 'planPreference', 'dailyPlan', 'dailyPlanRevision', 'recurrenceTemplate'].includes(record.type) && typeof record.workspaceId !== 'string') {
    throw new ValidationError('workspaceId is required.');
  }
  if (['item', 'recurrenceTemplate'].includes(record.type) && !Array.isArray(record.collectionRefs)) throw new ValidationError('collectionRefs is required.');
  if (record.type === 'project' && !['draft', 'active', 'someday', 'completed'].includes(record.status)) {
    throw new ValidationError('Choose a draft, active, someday or completed project status.');
  }
  if (record.type === 'project' && record.status !== 'draft' && !record.outcome?.trim()) throw new ValidationError('Add a desired outcome before activating this project.');
  if (record.type === 'savedView' && (typeof record.title !== 'string' || !record.title.trim() || record.title.length > 200 || typeof record.query !== 'string' || record.query.length > 200 ||
      !['all', 'item', 'list', 'project'].includes(record.resultType) ||
      !(['active', 'all', 'archived'].includes(record.resultState) || typeof record.resultState === 'string' && /^status:[^\r\n\t]{1,64}$/.test(record.resultState)))) {
    throw new ValidationError('Saved view has an invalid current shape.');
  }
  if (isCollection(record) && record.archived !== undefined && typeof record.archived !== 'boolean') throw new ValidationError('archived must be true or false.');
}

export async function commit(accountId, input, requestHash = digest(input)) {
  const receiptId = `receipt:${input.operationId}`;
  // All v1 writers serialize on the account state ETag. Reads can be stale;
  // a failed precondition retries the whole read/validate/commit decision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await read(accountId, "state");
    const previous = await read(accountId, receiptId);
    const current = await Promise.all(input.mutations.map(m => read(accountId, recordId(m.type, m.id))));
    const lookupForFence = async (type, id) => current.find((row, index) =>
      input.mutations[index].type === type && input.mutations[index].id === id)?.record ?? (await read(accountId, recordId(type, id)))?.record;
    if ((await erasedWorkspaceIds(accountId, input, current, lookupForFence, read)).length) {
      throw new ApiError(410, 'workspace_erased', 'This workspace was permanently erased. Remove its saved local operations.');
    }
    if (input.mutations.some((mutation, index) => mutation.action !== 'create' && !current[index]) && await hasErasureFence(accountId)) {
      throw new ApiError(404, 'record_not_found', 'The record is unavailable and cannot be changed or replayed.');
    }
    if (previous) {
      if (previous.requestHash !== requestHash) throw new ApiError(409, "operation_reused", "Use a new operationId for different content.");
      return previous.response;
    }
    const sequence = (state?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new ApiError(503, "sequence_exhausted", "Account sequence requires maintenance.");
    const satisfied = recurrenceAlreadySatisfied(input, current, sequence);
    if (satisfied) {
      // Persist the equivalent deterministic materialization as a receipt. A
      // later completion must not make retrying this accepted operation fail.
      const nextState = document(accountId, "state", { kind: "state", sequence });
      const batch = [state ? replace(nextState, state._etag) : create(nextState),
        create(document(accountId, receiptId, { kind: "receipt", requestHash, response: satisfied })),
        create(document(accountId, `change:${sequence}`, { kind: "change", sequence, response: satisfied }))];
      const result = await container.items.batch(batch, partition(accountId));
      const codes = [result.code, ...(result.result ?? []).map(row => row.statusCode)];
      if (codes.some(code => [409, 412].includes(code))) continue;
      if (result.code < 200 || result.code >= 300 || result.result?.length !== batch.length || result.result.some(row => row.statusCode < 200 || row.statusCode >= 300)) {
        throw new ApiError(503, "storage_unavailable", "Commit was not acknowledged. Retry the same operationId and content.");
      }
      return satisfied;
    }
    const conflicts = input.mutations.flatMap((proposed, i) => {
      const record = current[i]?.record ?? null;
      return ((proposed.action === "restore" ? !record?.deleted : record?.deleted) || (record?.version ?? 0) !== proposed.expectedVersion)
        ? [{ proposed, current: record }] : [];
    });
    const now = new Date().toISOString();
    const records = conflicts.length ? [] : input.mutations.map((m, i) => {
      const old = current[i]?.record;
      const record = { ...old, ...m.fields, id: m.id, type: m.type, accountId,
        version: m.expectedVersion + 1, createdUtc: old?.createdUtc ?? now, updatedUtc: now,
        deleted: m.action === "delete", deletedUtc: m.action === "delete" ? now : null };
      if (['item', 'recurrenceTemplate'].includes(m.type)) {
        try { normalizeMembership(record, old, m.fields); } catch (error) { throw new ValidationError(error.message); }
      }
      if (m.type === "item") {
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
      validateCurrentShape(record);
      if (record.type === 'planPreference' && (record.id !== record.workspaceId || current[i]?.record && record.workspaceId !== current[i].record.workspaceId)) {
        throw new ValidationError('Plan preference identity must match its workspace.');
      }
      await validateWorkspace(record, current[i]?.record, lookup);
      await validateCollections(record, current[i]?.record, lookup);
      await validateRecurrence(record, current[i]?.record, input.mutations[i], records, lookup, now);
      if (record.type === 'reviewDecision') validateReviewDecision(record, current[i]?.record, records);
      if (record.type === 'reviewReflection') await validateReviewReflection(record, current[i]?.record, records,
        async ref => records.find(candidate => candidate.type === ref.type && candidate.id === ref.id) ?? (await read(accountId, recordId(ref.type, ref.id)))?.record,
        candidate => workspaceOf(candidate, lookup));
      if (record.type === 'dailyPlan') await validateDailyPlan(record, current[i]?.record, records, lookup, input.mutations);
      if (record.type === 'dailyPlanRevision') validateDailyPlanRevision(record, current[i]?.record, records);
      if (record.type === 'brief') await validateBrief(record, current[i]?.record,
        async (type, id) => (type === 'brief' ? undefined : records.find(r => r.type === type && r.id === id)) ?? (await read(accountId, recordId(type, id)))?.record);
      if (record.type === 'review') await validateReview(record, current[i]?.record, input.mutations, records,
        async ref => {
          const target = (await read(accountId, recordId(ref.type, ref.id)))?.record;
          return target && await workspaceOf(target, lookup) === record.workspaceId ? target : null;
        });
      if (record.type === "clarification") {
        const originalItem = (await read(accountId, recordId('item', record.id)))?.record;
        validateClarification(record, current[i]?.record, input.mutations, originalItem);
        const item = records.find(r => r.type === "item" && r.id === record.id)
          ?? (await read(accountId, recordId("item", record.id)))?.record;
        const sourceDeleted = record.step === 'complete' && ['trash', 'convert'].includes(record.decision?.type);
        if (!item || item.deleted && !sourceDeleted && record.step !== 'reversed') throw new ApiError(404, "item_not_found", "Clarification requires an existing item in this account.");
      }
      if (record.type === 'item' && input.mutations[i].action === 'restore') {
        const clarification = records.find(candidate => candidate.type === 'clarification' && candidate.id === record.id)
          ?? (await read(accountId, recordId('clarification', record.id)))?.record;
        if (clarification?.step === 'complete' && clarification.decision?.type === 'convert') {
          throw new ValidationError('Undo the conversion through Clarify; an ordinary restore would duplicate the active container.');
        }
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
        const allowed = ["inbox", "next", "waiting", "deferred", "someday", "reference", "completed", "dropped", ...(list?.defaults?.statuses ?? userDefaults.statuses)];
        if (!allowed.includes(record.status)) {
          throw new ValidationError("status is not configured for this list or account.");
        }
      }
      if (["list", "project"].includes(record.type) && record.deleted && await hasContents(accountId, record, records)) {
        throw new ApiError(409, `${record.type}_not_empty`, `Move or delete this ${record.type}'s items and unlink child collections before deleting it.`);
      }
      if (isCollection(record) && current[i]?.record && !record.deleted &&
          record.workspaceId !== current[i].record.workspaceId &&
          await hasContents(accountId, record, records, record.workspaceId)) {
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
