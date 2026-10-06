import { normalizeMembership, memberships, isCollection, collectionContents, ancestry, refKey } from './collection-model.js?v=2';
import { workspaceOf } from './workspaces.js?v=2';
import { workflowFields, validateWorkflow } from './inbox-fields.js?v=2';
import { nextCollectionMoveOperation, projectCollectionMove } from './workspace-move.js?v=3';

const empty = () => ({ records: {}, queue: [], after: 0, draft: {} });
export const key = record => `${record.type}:${record.id}`;
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
const MAX_OPERATION_MUTATIONS = 20, MAX_OPERATION_BYTES = 65536;
const MAX_QUEUE_OPERATIONS = 1024, MAX_QUEUE_BYTES = 64 * 1024 * 1024;
let connection, resetting = false;
const resetChannel = new BroadcastChannel('todo-inbox-device-reset');
resetChannel.unref?.(); // Node's channel must not keep storage unit tests running.
async function closeConnection() {
  const current = connection;
  connection = null;
  try { (await current)?.close(); } catch { /* A failed open has no connection to close. */ }
}
resetChannel.onmessage = event => {
  if (event.data === 'start') { resetting = true; void closeConnection(); }
  if (event.data === 'cancel') resetting = false;
  if (event.data === 'done') location.reload();
};
function database() {
  if (resetting) return Promise.reject(new Error('The device database is being cleared. Wait for the app to reload.'));
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('todo-inbox-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts');
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = null; };
      if (resetting) request.result.close();
      resolve(request.result);
    };
    request.onerror = () => { connection = null; reject(request.error); };
  });
}

export async function clearDeviceDatabase(onBlocked) {
  if (resetting) throw new Error('The device database is already being cleared.');
  resetting = true;
  resetChannel.postMessage('start');
  try {
    await closeConnection();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('todo-inbox-v1');
      request.onblocked = () => onBlocked?.();
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    resetChannel.postMessage('done');
  } catch (failure) {
    resetting = false;
    resetChannel.postMessage('cancel');
    throw failure;
  }
}

// One transaction journals the intent and draft together. Resolve only on commit,
// never on the individual put's success (quota/abort can still follow it).
export async function transact(accountId, update) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('accounts', update ? 'readwrite' : 'readonly', { durability: 'strict' });
    const store = transaction.objectStore('accounts');
    const storageKey = accountId === null ? 'session' : `account:${accountId}`;
    const request = store.get(storageKey);
    let state, failure;
    request.onsuccess = () => {
      state = request.result ?? (accountId === null ? {} : empty());
      if (update) {
        try { update(state); store.put(state, storageKey); }
        catch (error) { failure = error; transaction.abort(); }
      }
    };
    transaction.oncomplete = () => resolve(state);
    transaction.onabort = transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Local storage failed.'));
  });
}

export function projected(state) {
  const records = structuredClone(state.records);
  for (const entry of state.queue) {
    for (const mutation of entry.operation.mutations) {
      const id = key(mutation);
      const previous = records[id];
      // Only explicit restore of this exact tombstone can reactivate a record.
      if (mutation.action === 'restore'
        ? !previous?.deleted || previous.version !== mutation.expectedVersion || entry.failure
        : previous?.deleted) continue;
      records[id] = { ...records[id], ...mutation.fields, type: mutation.type, id: mutation.id,
        ...(mutation.type === 'item' && mutation.fields?.status === 'completed' && previous?.status !== 'completed'
          ? { statusBeforeCompletion: previous?.status || 'inbox' } : {}),
        version: mutation.expectedVersion + 1, deleted: mutation.action === 'delete',
        ...(mutation.action === 'restore' ? { deletedUtc: null } : {}),
        localState: entry.failure || previous?.localState === 'Failed — needs attention' ? 'Failed — needs attention' : 'Saved on device — pending' };
      if (mutation.type === 'item') {
        normalizeMembership(records[id], previous, mutation.fields);
        records[id].nextAction = records[id].status === 'next';
        if (records[id].status === 'completed' && previous?.status !== 'completed' && previous?.workflowBeforeTransition?.status === 'completed' &&
            workflowFields.every(name => (records[id][name] ?? null) === (previous.workflowBeforeTransition[name] ?? null))) records[id].statusBeforeCompletion = previous.completionBeforeTransition;
        if (previous && workflowFields.some(name => name in (mutation.fields || {}) && (mutation.fields[name] ?? null) !== (previous[name] ?? null))) {
          records[id].workflowBeforeTransition = Object.fromEntries(workflowFields.map(name => [name, previous[name] ?? (name === 'waitingOn' ? '' : name === 'status' ? 'inbox' : null)]));
          records[id].completionBeforeTransition = previous.statusBeforeCompletion || 'inbox';
        }
      }
    }
  }
  return projectCollectionMove(records, state.workspaceMove);
}

function operationFor(state, accountId, mutations, operationId = crypto.randomUUID()) {
  if (!mutations.length || mutations.length > MAX_OPERATION_MUTATIONS) throw new Error('Save 1–20 records at a time.');
  const records = projected(state);
  const proposed = { ...records };
  for (const mutation of mutations) {
    proposed[key(mutation)] = { ...records[key(mutation)], ...mutation.fields, ...mutation, deleted: mutation.action === 'delete' };
    if (mutation.type === 'item') normalizeMembership(proposed[key(mutation)], records[key(mutation)], mutation.fields);
  }
  for (const mutation of mutations) {
    if (!['workspace', 'settings'].includes(mutation.type)) {
      const record = proposed[key(mutation)], old = records[key(mutation)];
      if (['item', 'list', 'project', 'review'].includes(record.type) && typeof record.workspaceId !== 'string') throw new Error('workspaceId is required.');
      if (record.type === 'item' && !Array.isArray(record.collectionRefs)) throw new Error('collectionRefs is required.');
      if (record.type === 'project' && !['draft', 'active', 'someday', 'completed'].includes(record.status)) throw new Error('Choose a draft, active, someday or completed project status.');
      if (record.type === 'project' && record.status !== 'draft' && !record.outcome?.trim()) throw new Error('Add a desired outcome before activating this project.');
      for (const member of [record, ...(old ? [old] : [])]) {
        const id = workspaceOf(member, proposed), workspace = proposed['workspace:' + id];
        if (id !== 'personal' && (!workspace || workspace.deleted || workspace.archived)) throw new Error('This workspace is unavailable or archived. Restore or unarchive it before saving.');
      }
      if (!record.deleted) {
        for (const ref of record.type === 'item' ? memberships(record) : record.parentRef ? [record.parentRef] : []) {
          const parent = proposed[refKey(ref)];
          if (!parent || parent.deleted) throw new Error('Destination collection is unavailable. Restore or remove its link.');
          if (workspaceOf(parent, proposed) !== workspaceOf(record, proposed)) throw new Error('Clear collection memberships before moving to another workspace.');
        }
        if (isCollection(record) && record.parentRef && ancestry(record.parentRef, proposed).some(ref => refKey(ref) === key(record))) throw new Error('A collection cannot be its own ancestor.');
      } else if (isCollection(record) && Object.values(proposed).some(child => collectionContents(child, record))) throw new Error('Move or unlink items and child collections before deleting this collection.');
    }
    if (mutation.type === 'item' && mutation.action !== 'delete') {
      const old = records[key(mutation)];
      validateWorkflow({ ...old, ...mutation.fields }, old, mutation.fields);
    }
  }
  const operation = { apiVersion: 1, accountId, operationId, mutations };
  if (size(operation) > MAX_OPERATION_BYTES) throw new Error('This capture is too large. Save fewer items at a time. Your text is still here.');
  return operation;
}

function queueRoom(state, entries) {
  let bytes = size(state.queue), count = state.queue.length;
  for (const entry of entries) {
    const nextBytes = bytes + size(entry) + (count ? 1 : 0);
    if (count >= MAX_QUEUE_OPERATIONS || nextBytes > MAX_QUEUE_BYTES) break;
    bytes = nextBytes; count++;
  }
  return count - state.queue.length;
}

function addEntries(state, entries, capture = false) {
  const available = queueRoom(state, entries);
  if (available !== entries.length) {
    if (capture) throw new Error(`This capture needs ${entries.length} pending saves, but this device has room for ${available}. Sync pending work, then try again. Your text is still here.`);
    throw new Error('The device queue is full (1,024 saves or 64 MiB). Sync or export pending work before adding more.');
  }
  state.queue.push(...entries);
}

export function enqueue(state, accountId, mutations) {
  if (state.workspaceMove) throw new Error('Finish or resume the pending collection move before saving more changes.');
  const operation = operationFor(state, accountId, mutations);
  addEntries(state, [{ operation }]);
  if (state.undoEdit && mutations.some(mutation => key(mutation) === key(state.undoEdit))) delete state.undoEdit;
}

function advanceCollectionMove(state, accountId) {
  const plan = state.workspaceMove;
  if (!plan || plan.failure || state.queue.length) return;
  try {
    const next = nextCollectionMoveOperation(plan, state.records, accountId, MAX_OPERATION_BYTES);
    if (!next) { delete state.workspaceMove; return; }
    const operation = operationFor({ ...state, workspaceMove: undefined }, accountId, next.operation.mutations, next.operation.operationId);
    addEntries(state, [{ operation, workspaceMoveId: plan.id, workspaceMovePhase: next.phase }]);
  } catch (failure) {
    plan.failure = failure.message;
  }
}

export function beginCollectionMove(state, accountId, plan) {
  if (state.workspaceMove) throw new Error('Another collection move is already in progress.');
  state.workspaceMove = plan;
  advanceCollectionMove(state, accountId);
}

export function continueCollectionMove(state, accountId) {
  advanceCollectionMove(state, accountId);
}

export function resumeCollectionMove(state, accountId) {
  const plan = state.workspaceMove;
  if (!plan) throw new Error('There is no collection move to resume.');
  const failed = state.queue[0];
  if (failed?.workspaceMoveId === plan.id && failed.failure) state.queue.shift();
  delete plan.failure;
  advanceCollectionMove(state, accountId);
  if (plan.failure) throw new Error(plan.failure);
}

export function enqueueCapture(state, accountId, mutations) {
  if (state.workspaceMove) throw new Error('Finish or resume the pending collection move before saving more changes.');
  const batches = [];
  for (const mutation of mutations) {
    const current = batches.at(-1);
    if (!current || current.mutations.length >= MAX_OPERATION_MUTATIONS ||
        size({ apiVersion: 1, accountId, operationId: current.operationId, mutations: [...current.mutations, mutation] }) > MAX_OPERATION_BYTES) {
      const next = { operationId: crypto.randomUUID(), mutations: [mutation] };
      if (size({ apiVersion: 1, accountId, ...next }) > MAX_OPERATION_BYTES) throw new Error('This capture is too large. Save fewer items at a time. Your text is still here.');
      batches.push(next);
    } else current.mutations.push(mutation);
  }
  const shadow = { ...state, queue: [...state.queue] };
  const entries = batches.map(batch => {
    const entry = { operation: operationFor(shadow, accountId, batch.mutations, batch.operationId) };
    shadow.queue.push(entry);
    return entry;
  });
  addEntries(state, entries, true);
  if (state.undoEdit && mutations.some(mutation => key(mutation) === key(state.undoEdit))) delete state.undoEdit;
  return entries.length;
}

// One editor save per account on this device; the outbox and inverse commit together.
export function rememberEdit(state, record, fields, now = Date.now()) {
  const empty = { workspaceId: 'personal', title: '', description: '', outcome: '', status: record.type === 'project' ? 'active' : 'inbox', waitingOn: '', contexts: [], areas: [], referenceLinks: [], collectionRefs: [], parentRef: null, kind: 'list' };
  state.undoEdit = {
    type: record.type, id: record.id, title: record.title, expectedVersion: record.version + 1,
    operationId: state.queue.at(-1).operation.operationId, expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    fields: Object.fromEntries(Object.keys(fields).map(name => [name, structuredClone(name === 'collectionRefs' ? memberships(record) : record[name] ?? empty[name] ?? null)]))
  };
}

export function canUndoEdit(state, now = Date.now()) {
  const undo = state.undoEdit;
  if (!undo || now >= undo.expiresAt || state.queue.some(entry => entry.failure)) return false;
  const record = projected(state)[key(undo)];
  return !!record && !record.deleted && record.version === undo.expectedVersion &&
    (state.records[key(undo)]?.version ?? 0) <= undo.expectedVersion;
}

export function undoEdit(state, accountId, operationId, now = Date.now()) {
  if (state.undoEdit?.operationId !== operationId || !canUndoEdit(state, now)) {
    throw new Error('This edit can no longer be undone. It expired, the record changed, or a save needs attention.');
  }
  const { type, id, expectedVersion, fields } = state.undoEdit;
  enqueue(state, accountId, [{ type, id, action: 'update', expectedVersion, fields: structuredClone(fields) }]);
  delete state.undoEdit;
}

export function applyReceipt(state, receipt, accountId) {
  if (receipt.apiVersion !== 1 || receipt.accountId !== accountId || !['committed', 'conflict'].includes(receipt.status)) {
    throw new Error('Unexpected acknowledgement. Pending work has been kept.');
  }
  for (const record of receipt.records) {
    if (record.accountId !== accountId) throw new Error('Account mismatch in response.');
    if (state.undoEdit && key(record) === key(state.undoEdit) &&
        (record.version > state.undoEdit.expectedVersion || record.version === state.undoEdit.expectedVersion && receipt.operationId !== state.undoEdit.operationId)) delete state.undoEdit;
    if ((state.records[key(record)]?.version ?? 0) < record.version) state.records[key(record)] = record;
  }
  const index = state.queue.findIndex(entry => entry.operation.operationId === receipt.operationId);
  if (index < 0) return;
  if (receipt.status === 'committed') state.queue.splice(index, 1);
  else {
    if (state.undoEdit && state.queue[index].operation.mutations.some(mutation => key(mutation) === key(state.undoEdit))) delete state.undoEdit;
    state.queue[index].failure = 'Another edit or deletion conflicts with this save. Review both versions.';
    state.queue[index].receipt = receipt;
    for (const conflict of receipt.conflicts) {
      const record = conflict.current;
      if (record && (state.records[key(record)]?.version ?? 0) < record.version) state.records[key(record)] = record;
    }
  }
}

export function captureMutations(draft, workspaceId = 'personal') {
  const source = draft.original ?? draft.text ?? '';
  const titles = (draft.text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!titles.length || titles.some(title => title.length > 200)) throw new Error('Enter a title of 1–200 characters on each non-empty line.');
  if (titles.length > 1000) throw new Error('Capture supports up to 1,000 non-empty lines at a time. Your text is still here; save the remainder as another capture.');
  if (source.length > 16000 || (draft.body ?? '').length > 4000) throw new Error('Capture text is limited to 16,000 characters and notes to 4,000.');
  const mutations = [];
  const projectId = draft.listId?.startsWith('project:') ? draft.listId.slice(8) : null;
  let listId = projectId ? null : draft.listId || null;
  if (draft.newList?.trim()) {
    if (draft.newList.length > 200) throw new Error('List title must be at most 200 characters.');
    listId = crypto.randomUUID();
    mutations.push({ type: 'list', id: listId, action: 'create', expectedVersion: 0,
      fields: { title: draft.newList.trim(), originalText: draft.newList, workspaceId } });
  }
  for (const title of titles) mutations.push({ type: 'item', id: crypto.randomUUID(), action: 'create', expectedVersion: 0,
    fields: { title, description: draft.body || '', originalText: source, workspaceId, listId, projectId,
      collectionRefs: [['list', listId], ['project', projectId]].filter(([, id]) => id).map(([type, id]) => ({ type, id })), status: 'inbox' } });
  return mutations;
}
