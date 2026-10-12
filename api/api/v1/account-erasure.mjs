import { createHash, randomUUID } from 'node:crypto';
import { bytes, canonical, document, partition } from './contract.mjs';

const BATCH_LIMIT = 50;
export const accountErasureFenceId = 'account-erasure';
const actorHash = value => createHash('sha256').update(value).digest('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const body = value => { const copy = structuredClone(value); delete copy._etag; return copy; };
const create = resourceBody => ({ operationType: 'Create', resourceBody });
const replace = resource => ({ operationType: 'Replace', id: resource.id, resourceBody: body(resource), ifMatch: resource._etag });
const remove = resource => ({ operationType: 'Delete', id: resource.id, ifMatch: resource._etag });
const emptyCounts = () => ({ privateRecords: 0, privateReceipts: 0, privateChanges: 0, privateOther: 0,
  sharedOwnedLists: 0, sharedMemberships: 0, sharedActorReceipts: 0 });
const addCounts = (left, right) => Object.fromEntries(Object.keys(emptyCounts()).map(name => [name, (left?.[name] || 0) + (right?.[name] || 0)]));
function privateCounts(rows) {
  return {
    privateRecords: rows.filter(row => row.kind === 'record').length,
    privateReceipts: rows.filter(row => row.kind === 'receipt').length,
    privateChanges: rows.filter(row => row.kind === 'change').length,
    privateOther: rows.filter(row => !['record', 'receipt', 'change'].includes(row.kind)).length,
    sharedOwnedLists: 0, sharedMemberships: 0, sharedActorReceipts: 0
  };
}

export class AccountErasureError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function requireTarget(accountId, authenticatedPrincipalId) {
  if (typeof accountId !== 'string' || !accountId) throw new AccountErasureError('account_required', 'Specify the exact account ID.');
  if (authenticatedPrincipalId !== accountId) throw new AccountErasureError('principal_mismatch', 'The authenticated principal must exactly match the storage target.');
}

export async function readAccountErasureFence(container, accountId) {
  try { return (await container.item(accountErasureFenceId, partition(accountId)).read()).resource ?? null; }
  catch (error) { if (error.code === 404) return null; throw error; }
}

export async function assertAccountAvailable(container, accountId) {
  if (await readAccountErasureFence(container, accountId)) {
    throw new AccountErasureError('account_erased', 'This account was permanently erased and is unavailable.', 410);
  }
}

export async function readPrivateDocuments(container, accountId) {
  const { resources } = await container.items.query({
    query: "SELECT * FROM c WHERE c.UserID=@u AND c.ObjectType='sync' AND c.ObjectID='v1'",
    parameters: [{ name: '@u', value: accountId }]
  }, { partitionKey: partition(accountId) }).fetchAll();
  return resources;
}

async function sharedListsFor(container, accountId) {
  const { resources } = await container.items.query({
    query: "SELECT * FROM c WHERE c.kind='shared-list' AND (c.ownerId=@u OR ARRAY_CONTAINS(c.members, {\"accountId\": @u}, true))",
    parameters: [{ name: '@u', value: accountId }]
  }).fetchAll();
  return resources;
}

const sharedPartition = listId => [`shared:${listId}`, 'shared-list', 'v1'];
async function sharedPartitionDocuments(container, listId) {
  const { resources } = await container.items.query({
    query: "SELECT * FROM c WHERE c.UserID=@u AND c.ObjectType='shared-list' AND c.ObjectID='v1'",
    parameters: [{ name: '@u', value: `shared:${listId}` }]
  }, { partitionKey: sharedPartition(listId) }).fetchAll();
  return resources;
}

async function sharedActorReceipts(container, accountId) {
  const { resources } = await container.items.query({
    query: "SELECT * FROM c WHERE c.kind='shared-receipt' AND c.response.accountId=@u",
    parameters: [{ name: '@u', value: accountId }]
  }).fetchAll();
  return resources;
}

async function inventory(container, accountId) {
  const privateRows = (await readPrivateDocuments(container, accountId)).filter(row => row.id !== accountErasureFenceId);
  const lists = await sharedListsFor(container, accountId);
  const partitions = await Promise.all(lists.map(list => sharedPartitionDocuments(container, list.listId)));
  const owned = lists.filter(list => list.ownerId === accountId);
  const memberships = lists.filter(list => list.ownerId !== accountId && list.members?.some(member => member.accountId === accountId));
  const receipts = await sharedActorReceipts(container, accountId);
  const kinds = name => privateRows.filter(row => row.kind === name);
  const other = privateRows.filter(row => !['record', 'receipt', 'change'].includes(row.kind));
  const identities = [
    ...privateRows.map(row => `private:${row.id}`),
    ...lists.map(list => `shared-list:${list.listId}`),
    ...receipts.map(row => `shared-receipt:${row.UserID}:${row.id}`)
  ].map(hash).sort();
  const etags = [
    ...privateRows.map(row => [`private:${row.id}`, row._etag]),
    ...partitions.flat().map(row => [`shared:${row.UserID}:${row.id}`, row._etag])
  ].sort((left, right) => left[0].localeCompare(right[0]));
  return {
    privateRows, lists, partitions, owned, memberships, receipts, identities,
    fingerprint: hash(canonical(etags)),
    counts: {
      privateRecords: kinds('record').length,
      privateReceipts: kinds('receipt').length,
      privateChanges: kinds('change').length,
      privateOther: other.length,
      sharedOwnedLists: owned.length,
      sharedMemberships: memberships.length,
      sharedActorReceipts: receipts.length
    },
    bytes: {
      privateRecords: kinds('record').reduce((sum, row) => sum + bytes(row), 0),
      privateReceipts: kinds('receipt').reduce((sum, row) => sum + bytes(row), 0),
      privateChanges: kinds('change').reduce((sum, row) => sum + bytes(row), 0),
      privateOther: other.reduce((sum, row) => sum + bytes(row), 0),
      sharedOwnedPartitions: owned.reduce((sum, list) => sum + partitions[lists.indexOf(list)].reduce((total, row) => total + bytes(row), 0), 0),
      sharedMembershipPartitions: memberships.reduce((sum, list) => sum + bytes(list), 0),
      sharedActorReceipts: receipts.reduce((sum, row) => sum + bytes(row), 0)
    }
  };
}

export async function createAccountErasurePlan(container, accountId, {
  authenticatedPrincipalId, backupExpiresAfterUtc, erasureId = randomUUID(), plannedUtc = new Date().toISOString()
} = {}) {
  requireTarget(accountId, authenticatedPrincipalId);
  if (!Number.isFinite(Date.parse(backupExpiresAfterUtc))) throw new AccountErasureError('backup_expiry_required', 'Record when the last pre-erasure backup expires.');
  const existing = await readAccountErasureFence(container, accountId);
  if (existing && existing.erasureId !== erasureId) throw new AccountErasureError('already_fenced', 'This account already has a different erasure decision.');
  const details = await inventory(container, accountId);
  const state = details.privateRows.find(row => row.id === 'state');
  return {
    formatVersion: 1, accountId, authenticatedPrincipalId, erasureId, plannedUtc,
    backupExpiresAfterUtc: new Date(backupExpiresAfterUtc).toISOString(),
    stateEtag: state?._etag ?? null, plannedSequence: state?.sequence ?? 0,
    fingerprint: details.fingerprint, candidateHashes: details.identities,
    counts: details.counts, bytes: details.bytes, alreadyFenced: Boolean(existing)
  };
}

async function runBatch(container, partitionKey, operations) {
  for (let start = 0; start < operations.length; start += BATCH_LIMIT) {
    const batch = operations.slice(start, start + BATCH_LIMIT);
    const result = await container.items.batch(batch, partitionKey);
    const codes = [result.code, ...(result.result || []).map(entry => entry.statusCode)];
    if (codes.some(code => code < 200 || code >= 300)) throw new AccountErasureError('storage_conflict', 'Erasure storage changed; resume with the same plan.', 503);
  }
}

async function begin(container, plan, now) {
  const documents = await readPrivateDocuments(container, plan.accountId);
  const state = documents.find(row => row.id === 'state');
  if ((state?._etag ?? null) !== plan.stateEtag || (state?.sequence ?? 0) !== plan.plannedSequence) {
    throw new AccountErasureError('plan_changed', 'Account storage changed after the dry run; create a new plan.', 409);
  }
  const fence = document(plan.accountId, accountErasureFenceId, {
    kind: 'account-erasure', erasureId: plan.erasureId, targetAccountId: plan.accountId,
    status: 'erasing', startedUtc: now, completedUtc: null,
    expectedCounts: plan.counts, actualCounts: emptyCounts(),
    sharedDisposition: { ownedLists: 'deleted', otherLists: 'membership-and-actor-receipts-removed', collaborativeItems: 'retained' },
    backupExpiresAfterUtc: plan.backupExpiresAfterUtc
  });
  const stateOperation = state
    ? { operationType: 'Replace', id: state.id, resourceBody: body(state), ifMatch: state._etag }
    : create(document(plan.accountId, 'state', { kind: 'state', sequence: 0 }));
  const result = await container.items.batch([stateOperation, create(fence)], partition(plan.accountId));
  const codes = [result.code, ...(result.result || []).map(entry => entry.statusCode)];
  if (codes.some(code => code < 200 || code >= 300)) throw new AccountErasureError('plan_changed', 'The erasure fence was not acknowledged; inspect storage before retrying.', 409);
}

async function purgeShared(container, accountId) {
  const receiptPrefix = `receipt:${actorHash(accountId)}:`;
  const counts = emptyCounts();
  let cleanPasses = 0;
  for (let pass = 0; pass < 10; pass++) {
    const lists = await sharedListsFor(container, accountId);
    const actorReceipts = await sharedActorReceipts(container, accountId);
    const listIds = new Set([...lists.map(list => list.listId), ...actorReceipts.map(row => row.UserID.slice('shared:'.length))]);
    let changed = false;
    for (const listId of listIds) {
      const rows = await sharedPartitionDocuments(container, listId);
      const list = rows.find(row => row.id === 'list');
      if (!list) {
        const receipts = rows.filter(row => row.kind === 'shared-receipt' && row.id.startsWith(receiptPrefix));
        await runBatch(container, sharedPartition(listId), receipts.map(remove)); counts.sharedActorReceipts += receipts.length; changed ||= receipts.length > 0; continue;
      }
      if (list.ownerId === accountId) {
        counts.sharedOwnedLists++;
        counts.sharedActorReceipts += rows.filter(row => row.kind === 'shared-receipt' && row.id.startsWith(receiptPrefix)).length;
        await runBatch(container, sharedPartition(listId), rows.map(remove));
        changed ||= rows.length > 0;
        continue;
      }
      const member = list.members?.some(entry => entry.accountId === accountId);
      const receipts = rows.filter(row => row.kind === 'shared-receipt' && row.id.startsWith(receiptPrefix));
      if (!member && !receipts.length) continue;
      const operations = [];
      if (member) { counts.sharedMemberships++; operations.push(replace({ ...list, members: list.members.filter(entry => entry.accountId !== accountId) })); }
      counts.sharedActorReceipts += receipts.length;
      operations.push(...receipts.map(remove));
      await runBatch(container, sharedPartition(listId), operations);
      changed = true;
    }
    const remaining = await sharedListsFor(container, accountId);
    if (!remaining.length && !(await sharedActorReceipts(container, accountId)).length) {
      if (++cleanPasses === 2) return counts;
      continue;
    }
    cleanPasses = 0;
    if (!changed && pass === 9) break;
  }
  throw new AccountErasureError('verification_failed', 'Shared-list references remain after erasure.', 503);
}

export async function applyAccountErasure(container, plan, {
  confirm, now = new Date().toISOString(), interruptAfter, restoreReplay = false
} = {}) {
  requireTarget(plan?.accountId, plan?.authenticatedPrincipalId);
  if (plan.formatVersion !== 1 || confirm !== plan.erasureId || !Array.isArray(plan.candidateHashes)) {
    throw new AccountErasureError('confirmation_required', 'Confirm the exact erasure ID from the dry-run plan.');
  }
  let fence = await readAccountErasureFence(container, plan.accountId);
  if (fence && fence.erasureId !== plan.erasureId) throw new AccountErasureError('different_erasure', 'A different erasure decision already fences this account.', 409);
  if (!fence) {
    const current = await inventory(container, plan.accountId);
    if (!restoreReplay && current.fingerprint !== plan.fingerprint) throw new AccountErasureError('plan_changed', 'Account storage changed after the dry run; create a new plan.', 409);
    await begin(container, { ...plan, ...(restoreReplay ? {
      stateEtag: current.privateRows.find(row => row.id === 'state')?._etag ?? null,
      plannedSequence: current.privateRows.find(row => row.id === 'state')?.sequence ?? 0
    } : {}) }, now);
    if (interruptAfter === 'fence') throw new AccountErasureError('interrupted', 'Injected interruption after fence.', 503);
  }
  let privateRows = await readPrivateDocuments(container, plan.accountId);
  const privateCandidates = privateRows.filter(row => row.id !== accountErasureFenceId);
  await runBatch(container, partition(plan.accountId), privateCandidates.map(remove));
  fence = await readAccountErasureFence(container, plan.accountId);
  if (privateCandidates.length) {
    await runBatch(container, partition(plan.accountId), [replace({ ...fence, actualCounts: addCounts(fence.actualCounts, privateCounts(privateCandidates)) })]);
  }
  if (interruptAfter === 'private') throw new AccountErasureError('interrupted', 'Injected interruption after private purge.', 503);
  const sharedCounts = await purgeShared(container, plan.accountId);
  fence = await readAccountErasureFence(container, plan.accountId);
  if (Object.values(sharedCounts).some(Boolean)) {
    await runBatch(container, partition(plan.accountId), [replace({ ...fence, actualCounts: addCounts(fence.actualCounts, sharedCounts) })]);
  }
  if (interruptAfter === 'shared') throw new AccountErasureError('interrupted', 'Injected interruption after shared purge.', 503);
  privateRows = await readPrivateDocuments(container, plan.accountId);
  const remaining = privateRows.filter(row => row.id !== accountErasureFenceId);
  const shared = await sharedListsFor(container, plan.accountId);
  if (remaining.length || shared.length) throw new AccountErasureError('verification_failed', 'Account content remains after erasure.', 503);
  fence = await readAccountErasureFence(container, plan.accountId);
  if (fence.status !== 'complete') {
    await runBatch(container, partition(plan.accountId), [replace({ ...fence, status: 'complete', completedUtc: now })]);
  }
  return {
    status: 'complete', erasureId: plan.erasureId, accountId: plan.accountId,
    startedUtc: fence.startedUtc, completedUtc: fence.completedUtc || now,
    expectedCounts: plan.counts, actualCounts: fence.actualCounts,
    sharedDisposition: fence.sharedDisposition,
    backupExpiresAfterUtc: plan.backupExpiresAfterUtc
  };
}
