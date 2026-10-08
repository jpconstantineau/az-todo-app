import { createHash, randomUUID } from 'node:crypto';
import { bytes, canonical, document, partition, recordId } from './contract.mjs';

const BATCH_LIMIT = 50;
export const erasureMarkerId = workspaceId => `workspace-erasure:${workspaceId}`;
const recordKey = value => value?.type && value?.id ? `${value.type}:${value.id}` : null;
const hash = value => createHash('sha256').update(value).digest('hex');
const body = value => {
  const copy = structuredClone(value);
  delete copy._etag;
  return copy;
};
const create = resourceBody => ({ operationType: 'Create', resourceBody });
const replace = resource => ({ operationType: 'Replace', id: resource.id, resourceBody: body(resource), ifMatch: resource._etag });
const remove = resource => ({ operationType: 'Delete', id: resource.id, ifMatch: resource._etag });

export class WorkspaceErasureError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function requireTarget(accountId, workspaceId) {
  if (typeof accountId !== 'string' || !accountId) throw new WorkspaceErasureError('account_required', 'Specify the exact account ID.');
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
    throw new WorkspaceErasureError('workspace_required', 'Specify a valid workspace ID.');
  }
  if (workspaceId === 'personal') throw new WorkspaceErasureError('personal_forbidden', 'Personal requires the whole-account erasure procedure.');
}

export async function readAccountDocuments(container, accountId) {
  const { resources } = await container.items.query({
    query: "SELECT * FROM c WHERE c.UserID=@u AND c.ObjectType='sync' AND c.ObjectID='v1'",
    parameters: [{ name: '@u', value: accountId }]
  }, { partitionKey: partition(accountId) }).fetchAll();
  return resources;
}

function currentRecords(documents) {
  return new Map(documents.filter(row => row.kind === 'record' && row.record).map(row => [recordKey(row.record), row.record]));
}

function ownerKey(record) {
  if (record.type === 'clarification') return `item:${record.id}`;
  if (record.type === 'reviewDecision') return `review:${record.reviewId}`;
  if (record.type === 'brief') return `${record.subjectType}:${record.subjectId}`;
  if (record.type === 'projectPlanRevision') return `project:${record.projectId}`;
  return null;
}

export function workspaceScope(documents, workspaceId) {
  const records = currentRecords(documents);
  const workspace = records.get(`workspace:${workspaceId}`);
  const marker = documents.find(row => row.id === erasureMarkerId(workspaceId));
  if (!workspace && !marker) throw new WorkspaceErasureError('workspace_not_found', 'The exact workspace was not found in this account.');
  const scoped = new Set();
  for (const [key, record] of records) {
    if (record.type === 'workspace' ? record.id === workspaceId : record.workspaceId === workspaceId) scoped.add(key);
  }
  let changed;
  do {
    changed = false;
    for (const [key, record] of records) {
      const owner = ownerKey(record);
      if (owner && scoped.has(owner) && !scoped.has(key)) { scoped.add(key); changed = true; }
    }
  } while (changed);
  for (const [key, record] of records) {
    if (ownerKey(record) && !records.has(ownerKey(record))) {
      throw new WorkspaceErasureError('orphan_history', `Resolve orphaned derived record ${hash(key)} before erasure.`);
    }
  }
  return { records, scoped, workspace, marker };
}

function scopeHashes(scoped) {
  return [...scoped].map(hash).sort();
}

function scopeSet(plan) { return new Set(plan.recordKeyHashes); }
function inScope(value, hashes) {
  const key = recordKey(value);
  return key ? hashes.has(hash(key)) : false;
}
function conflictInScope(value, hashes) {
  return inScope(value?.proposed, hashes) || inScope(value?.current, hashes);
}
function responseTouches(response, hashes) {
  return (response?.records || []).some(record => inScope(record, hashes)) ||
    (response?.proposed || []).some(mutation => inScope(mutation, hashes)) ||
    (response?.conflicts || []).some(conflict => conflictInScope(conflict, hashes));
}

function redactResponse(response, hashes, sequence) {
  if (!responseTouches(response, hashes)) return null;
  const records = (response.records || []).filter(record => !inScope(record, hashes));
  const proposed = (response.proposed || []).filter(mutation => !inScope(mutation, hashes));
  const conflicts = (response.conflicts || []).filter(conflict => !conflictInScope(conflict, hashes));
  const status = response.status === 'conflict' && conflicts.length ? 'conflict' : 'committed';
  return {
    apiVersion: 1,
    accountId: response.accountId,
    operationId: `workspace-erasure-${sequence}`,
    sequence: response.sequence,
    status,
    records,
    ...(status === 'conflict' ? { proposed, conflicts } : {})
  };
}

function fingerprint(documents, scoped) {
  const candidates = documents.filter(row => row.kind === 'record' && scoped.has(recordKey(row.record)) ||
    row.kind === 'receipt' && responseTouches(row.response, new Set(scopeHashes(scoped))) ||
    row.kind === 'change' && responseTouches(row.response, new Set(scopeHashes(scoped))));
  return hash(canonical(candidates.map(row => [row.id, row._etag]).sort((a, b) => a[0].localeCompare(b[0]))));
}

export function createWorkspaceErasurePlan(documents, accountId, workspaceId, erasureId = randomUUID()) {
  requireTarget(accountId, workspaceId);
  const { scoped, workspace, marker } = workspaceScope(documents, workspaceId);
  if (marker && marker.erasureId !== erasureId) throw new WorkspaceErasureError('already_fenced', 'This workspace already has a different erasure record.');
  const state = documents.find(row => row.id === 'state');
  if (!state || !Number.isSafeInteger(state.sequence)) throw new WorkspaceErasureError('state_missing', 'The account state is unavailable.');
  const hashes = new Set(scopeHashes(scoped));
  const receipts = documents.filter(row => row.kind === 'receipt' && responseTouches(row.response, hashes));
  const changes = documents.filter(row => row.kind === 'change' && responseTouches(row.response, hashes));
  const recordRows = documents.filter(row => row.kind === 'record' && scoped.has(recordKey(row.record)));
  return {
    formatVersion: 1, accountId, workspaceId, erasureId,
    plannedSequence: state.sequence, stateEtag: state._etag,
    recordKeyHashes: [...hashes].sort(), fingerprint: fingerprint(documents, scoped),
    counts: { records: recordRows.length, receipts: receipts.length, changes: changes.length },
    bytes: { records: recordRows.reduce((sum, row) => sum + bytes(row), 0), receipts: receipts.reduce((sum, row) => sum + bytes(row), 0), changes: changes.reduce((sum, row) => sum + bytes(row), 0) },
    alreadyFenced: Boolean(marker), workspaceVersion: workspace?.version ?? null
  };
}

async function runBatch(container, accountId, operations) {
  for (let start = 0; start < operations.length; start += BATCH_LIMIT) {
    const batch = operations.slice(start, start + BATCH_LIMIT);
    const result = await container.items.batch(batch, partition(accountId));
    const codes = [result.code, ...(result.result || []).map(entry => entry.statusCode)];
    if (codes.some(code => code < 200 || code >= 300)) throw new WorkspaceErasureError('storage_conflict', 'Erasure storage changed; resume with the same plan.');
  }
}

async function begin(container, documents, plan, now) {
  const state = documents.find(row => row.id === 'state');
  if (!state || state._etag !== plan.stateEtag || state.sequence !== plan.plannedSequence) {
    throw new WorkspaceErasureError('plan_changed', 'Account storage changed after the dry run; create a new plan.');
  }
  const marker = document(plan.accountId, erasureMarkerId(plan.workspaceId), {
    kind: 'workspace-erasure', workspaceId: plan.workspaceId, erasureId: plan.erasureId,
    status: 'erasing', erasedUtc: now, completedSequence: null
  });
  const sequence = state.sequence + 1;
  const nextState = { ...body(state), sequence };
  const response = { apiVersion: 1, accountId: plan.accountId, operationId: `workspace-erasure-${sequence}`,
    sequence, status: 'committed', records: [], erasedWorkspaces: [{ workspaceId: plan.workspaceId, erasedUtc: now }] };
  const result = await container.items.batch([replace({ ...nextState, _etag: state._etag }), create(marker),
    create(document(plan.accountId, `change:${sequence}`, { kind: 'change', sequence, response }))], partition(plan.accountId));
  if (result.code < 200 || result.code >= 300 || result.result?.some(entry => entry.statusCode < 200 || entry.statusCode >= 300)) {
    throw new WorkspaceErasureError('plan_changed', 'The erasure fence was not acknowledged; inspect storage before retrying.');
  }
  return sequence;
}

export async function applyWorkspaceErasure(container, plan, { confirm, now = new Date().toISOString(), interruptAfter } = {}) {
  requireTarget(plan.accountId, plan.workspaceId);
  if (plan.formatVersion !== 1 || confirm !== plan.erasureId || !Array.isArray(plan.recordKeyHashes)) {
    throw new WorkspaceErasureError('confirmation_required', 'Confirm the exact erasure ID from the dry-run plan.');
  }
  let documents = await readAccountDocuments(container, plan.accountId);
  let marker = documents.find(row => row.id === erasureMarkerId(plan.workspaceId));
  if (marker && marker.erasureId !== plan.erasureId) throw new WorkspaceErasureError('different_erasure', 'A different erasure record already fences this workspace.');
  if (!marker) {
    const current = createWorkspaceErasurePlan(documents, plan.accountId, plan.workspaceId, plan.erasureId);
    if (current.fingerprint !== plan.fingerprint) throw new WorkspaceErasureError('plan_changed', 'Account storage changed after the dry run; create a new plan.');
    await begin(container, documents, plan, now);
    if (interruptAfter === 'fence') throw new WorkspaceErasureError('interrupted', 'Injected interruption after fence.');
    documents = await readAccountDocuments(container, plan.accountId);
    marker = documents.find(row => row.id === erasureMarkerId(plan.workspaceId));
  }
  const hashes = scopeSet(plan);
  const receiptDeletes = documents.filter(row => row.kind === 'receipt' && responseTouches(row.response, hashes)).map(remove);
  await runBatch(container, plan.accountId, receiptDeletes);
  if (interruptAfter === 'receipts') throw new WorkspaceErasureError('interrupted', 'Injected interruption after receipts.');
  documents = await readAccountDocuments(container, plan.accountId);
  const changeReplacements = documents.filter(row => row.kind === 'change').flatMap(row => {
    const response = redactResponse(row.response, hashes, row.sequence);
    return response ? [replace({ ...row, response })] : [];
  });
  await runBatch(container, plan.accountId, changeReplacements);
  if (interruptAfter === 'changes') throw new WorkspaceErasureError('interrupted', 'Injected interruption after changes.');
  documents = await readAccountDocuments(container, plan.accountId);
  const recordDeletes = documents.filter(row => row.kind === 'record' && inScope(row.record, hashes)).map(remove);
  await runBatch(container, plan.accountId, recordDeletes);
  if (interruptAfter === 'records') throw new WorkspaceErasureError('interrupted', 'Injected interruption after records.');
  documents = await readAccountDocuments(container, plan.accountId);
  if (documents.some(row => row.kind === 'receipt' && responseTouches(row.response, hashes) || row.kind === 'change' && responseTouches(row.response, hashes) || row.kind === 'record' && inScope(row.record, hashes))) {
    throw new WorkspaceErasureError('verification_failed', 'Scoped workspace data remains after erasure.');
  }
  const state = documents.find(row => row.id === 'state');
  marker = documents.find(row => row.id === erasureMarkerId(plan.workspaceId));
  if (marker.status === 'complete') return { status: 'complete', resumed: true, counts: plan.counts, completedSequence: marker.completedSequence };
  await runBatch(container, plan.accountId, [replace({ ...marker, status: 'complete', completedSequence: state.sequence })]);
  return { status: 'complete', resumed: marker.status === 'erasing', counts: plan.counts, completedSequence: state.sequence };
}

export async function erasedWorkspaceIds(accountId, input, current, lookup, readDocument) {
  const workspaces = new Set();
  const addWorkspace = async record => {
    if (!record) return;
    let workspaceId = record.workspaceId;
    if (record.type === 'clarification') workspaceId = (await lookup('item', record.id))?.workspaceId;
    if (record.type === 'reviewDecision') workspaceId = (await lookup('review', record.reviewId))?.workspaceId;
    if (record.type === 'brief') workspaceId = (await lookup(record.subjectType, record.subjectId))?.workspaceId;
    if (record.type === 'projectPlanRevision') workspaceId = (await lookup('project', record.projectId))?.workspaceId;
    if (workspaceId) workspaces.add(workspaceId);
  };
  for (const [index, mutation] of input.mutations.entries()) {
    if (mutation.type === 'workspace') workspaces.add(mutation.id);
    else {
      await addWorkspace(current[index]?.record);
      await addWorkspace({ ...current[index]?.record, ...mutation.fields, type: mutation.type, id: mutation.id });
    }
  }
  const erased = [];
  for (const workspaceId of workspaces) if (workspaceId !== 'personal' && await readDocument(accountId, erasureMarkerId(workspaceId))) erased.push(workspaceId);
  return erased;
}
