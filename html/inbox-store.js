import { normalizeMembership, memberships, isCollection, collectionContents, ancestry, archivedAncestor, refKey } from './collection-model.js?v=5';
import { PERSONAL, purgeWorkspaceState, workspaceOf } from './workspaces.js?v=5';
import { workflowFields, validateWorkflow } from './inbox-fields.js?v=5';
import { nextCollectionMoveOperation, projectCollectionMove } from './workspace-move.js?v=5';
import { materializationDate, nextAfterResolution, occurrenceId, recurrenceSnapshot } from './recurrence-model.js?v=1';
import { validateProjectPlanOperation } from './project-planning-model.js?v=1';

const empty = () => ({ records: {}, queue: [], after: 0, draft: {} });
export const LOCAL_PROFILE = 'device-local';
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

const meaningfulDraft = value => {
  if (value == null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.some(meaningfulDraft);
  if (typeof value !== 'object') return true;
  return Object.entries(value).some(([name, entry]) => !['workspaceId', 'navigation', 'day', 'editOpen', 'defaultsOpen', 'open'].includes(name) && meaningfulDraft(entry));
};

function draftEntries(state, includeValues = false) {
  const drafts = [];
  const add = (workspaceId, draft = {}) => {
    const labels = {
      capture: 'Capture', edit: 'Editor', defaults: 'Task options', clarification: 'Clarification', brief: 'Brief',
      projectPlanning: 'Project planning', review: 'Review', extraction: 'Capture review', recurrence: 'Recurring task'
    };
    for (const [name, label] of Object.entries(labels)) {
      const value = draft[name], meaningful = name === 'extraction'
        ? meaningfulDraft(value?.draft)
        : meaningfulDraft(value);
      if (meaningful) drafts.push({ workspaceId, workflow: name, label, ...(includeValues ? { value } : {}) });
    }
  };
  add('personal', state.draft);
  for (const [workspaceId, draft] of Object.entries(state.workspaceDrafts || {})) add(workspaceId, draft);
  if (meaningfulDraft(state.preferenceDraft?.defaults)) drafts.push({ workspaceId: null, workflow: 'defaults', label: 'Account task options', ...(includeValues ? { value: state.preferenceDraft.defaults } : {}) });
  return drafts;
}

const resetLossState = state => ({
  queue: state.queue || [],
  drafts: draftEntries(state, true),
  workspaceMove: state.workspaceMove || null,
  undoEdit: state.undoEdit || null
});

async function lossFingerprint(documents) {
  const serialized = JSON.stringify(documents
    .filter(document => String(document.storageKey).startsWith('account:') || document.storageKey === 'local-profile')
    .sort((left, right) => String(left.storageKey).localeCompare(String(right.storageKey)))
    .map(document => [document.storageKey, resetLossState(document.state)]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Read-only reset inventory for the routed destructive review. Inactive accounts
// are aggregated so their identities and private text never enter the active UI.
export async function deviceResetImpact(accountId) {
  const db = await database();
  const documents = await new Promise((resolve, reject) => {
    const transaction = db.transaction('accounts', 'readonly');
    const store = transaction.objectStore('accounts'), values = store.getAll(), keys = store.getAllKeys();
    transaction.oncomplete = () => resolve(keys.result.map((storageKey, index) => ({ storageKey, state: values.result[index] })));
    transaction.onerror = () => reject(transaction.error);
  });
  const current = documents.find(document => document.storageKey === profileStorageKey(accountId))?.state
    || await transact(accountId);
  const records = projected(current);
  const operations = (current.queue || []).map(entry => ({
    operationId: entry.operation.operationId,
    failed: !!entry.failure,
    records: entry.operation.mutations.map(mutation => ({
      type: mutation.type,
      title: mutation.fields?.title || records[key(mutation)]?.title || mutation.id
    }))
  }));
  const drafts = draftEntries(current);
  let inactiveAccounts = 0, inactiveLocalProfiles = 0, inactiveOperations = 0, inactiveDrafts = 0;
  for (const { storageKey, state: document } of documents) {
    if ((!String(storageKey).startsWith('account:') && storageKey !== 'local-profile') || storageKey === profileStorageKey(accountId)) continue;
    if (storageKey === 'local-profile') inactiveLocalProfiles++;
    else inactiveAccounts++;
    inactiveOperations += document.queue?.length || 0;
    inactiveDrafts += draftEntries(document).length + (document.workspaceMove ? 1 : 0) + (document.undoEdit ? 1 : 0);
  }
  const impact = {
    operations,
    drafts,
    collectionMove: current.workspaceMove ? { title: current.workspaceMove.root?.title || current.workspaceMove.root?.id || 'Collection move' } : null,
    undoEdit: current.undoEdit ? { type: current.undoEdit.type, title: current.undoEdit.title || current.undoEdit.id } : null,
    inactive: { accounts: inactiveAccounts, localProfiles: inactiveLocalProfiles, operations: inactiveOperations, drafts: inactiveDrafts }
  };
  const fingerprintDocuments = documents.some(document => document.storageKey === profileStorageKey(accountId))
    ? documents
    : [...documents, { storageKey: profileStorageKey(accountId), state: current }];
  impact.fingerprint = await lossFingerprint(fingerprintDocuments);
  return impact;
}

const profileStorageKey = accountId => accountId === LOCAL_PROFILE ? 'local-profile' : `account:${accountId}`;

function hasRecovery(state = {}) {
  return !!(state.queue?.length || draftEntries(state).length || state.workspaceMove || state.undoEdit ||
    Object.keys(state.sharedLists?.drafts || {}).length);
}
const hasLocalWork = state => hasRecovery(state) || Object.keys(state?.records || {}).length > 0;

// Adopt only after an explicit sign-in intent. The source deletion, destination
// write and intent clear share one transaction, so interruption cannot duplicate
// or orphan the device-local queue.
export async function adoptLocalProfile(accountId) {
  if (!accountId || accountId === LOCAL_PROFILE) throw new Error('A verified account is required to sync device-only work.');
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('accounts', 'readwrite', { durability: 'strict' });
    const store = transaction.objectStore('accounts');
    const sourceRequest = store.get('local-profile');
    const destinationRequest = store.get(profileStorageKey(accountId));
    const sessionRequest = store.get('session');
    let adopted, failure;
    const prepare = () => {
      if (![sourceRequest, destinationRequest, sessionRequest].every(request => request.readyState === 'done')) return;
      try {
        const session = sessionRequest.result || {};
        if (session.adoptLocal !== true) throw new Error('Choose Sign in to sync before moving device-only work.');
        const source = sourceRequest.result;
        const destination = destinationRequest.result || empty();
        if (source && hasLocalWork(source) && hasRecovery(destination)) {
          throw new Error('This account already has unfinished device recovery. Resolve or export it before syncing device-only work.');
        }
        if (source && hasLocalWork(source)) {
          adopted = structuredClone(source);
          adopted.queue = (source.queue || []).map(entry => ({ ...entry,
            operation: { ...entry.operation, accountId } }));
          for (const name of ['records', 'after', 'defaultSettings', 'accountName', 'sharedLists', 'workspaceErasureNotice']) {
            if (destination[name] !== undefined) adopted[name] = structuredClone(destination[name]);
            else if (['records', 'after'].includes(name)) adopted[name] = name === 'records' ? {} : 0;
            else delete adopted[name];
          }
          store.put(adopted, profileStorageKey(accountId));
          store.delete('local-profile');
        } else {
          adopted = destination;
          if (source) store.delete('local-profile');
        }
        store.put({ ...session, accountId, paused: false, adoptLocal: false }, 'session');
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    sourceRequest.onsuccess = destinationRequest.onsuccess = sessionRequest.onsuccess = prepare;
    transaction.oncomplete = () => resolve(adopted);
    transaction.onabort = transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Local adoption failed.'));
  });
}

// One transaction journals the intent and draft together. Resolve only on commit,
// never on the individual put's success (quota/abort can still follow it).
export async function transact(accountId, update) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('accounts', update ? 'readwrite' : 'readonly', { durability: 'strict' });
    const store = transaction.objectStore('accounts');
    const storageKey = accountId === null ? 'session' : profileStorageKey(accountId);
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
        localState: entry.failure || previous?.localState === 'Failed — needs attention' ? 'Failed — needs attention'
          : entry.operation.accountId === LOCAL_PROFILE ? 'Saved on this device' : 'Saved on device — pending' };
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

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function validateRecurrenceMutation(mutation, record, old, proposed, records) {
  const fail = message => { throw new Error(message); };
  if (record.type === 'recurrenceTemplate') {
    if (record.deleted) fail('Recurring templates are stopped, not deleted.');
    if (!old) return;
    const opening = !old.openOccurrenceId && record.openOccurrenceId;
    const resolving = old.openOccurrenceId && !record.openOccurrenceId;
    const cursor = ['nextOccurrenceNumber', 'nextIntendedDate', 'openOccurrenceId', 'lastResolvedUtc'];
    if (old.tombstoned && !(resolving && Object.keys(mutation.fields).every(name => cursor.includes(name)))) fail('A stopped recurring template is read-only history.');
    if (!cursor.some(name => !same(record[name] ?? null, old[name] ?? null))) return;
    if (!old.openOccurrenceId && !record.openOccurrenceId && !same(record.rule, old.rule) && record.nextOccurrenceNumber === old.nextOccurrenceNumber && record.lastResolvedUtc === old.lastResolvedUtc && record.nextIntendedDate === (record.lastResolvedUtc ? nextAfterResolution(record.rule, record.lastResolvedUtc) : record.rule.anchorDate)) return;
    if (opening) {
      const item = proposed[`item:${record.openOccurrenceId}`], intended = materializationDate(old);
      if (!item || !intended || item.id !== occurrenceId(old.id, old.nextOccurrenceNumber) || item.recurrenceNumber !== old.nextOccurrenceNumber || record.nextOccurrenceNumber !== old.nextOccurrenceNumber + 1 || item.intendedDate !== intended || record.nextIntendedDate !== intended || item.recurrenceTemplateId !== old.id || item.sourceTemplateVersion !== old.version || item.occurrenceState !== 'open' || item.occurrenceResolvedUtc !== null || !same(recurrenceSnapshot(item), recurrenceSnapshot(old))) fail('Materialization must atomically create the exact next occurrence.');
      return;
    }
    if (resolving) {
      const item = proposed[`item:${old.openOccurrenceId}`];
      if (!item || !['completed', 'skipped'].includes(item.occurrenceState) || item.occurrenceResolvedUtc !== record.lastResolvedUtc || record.nextOccurrenceNumber !== old.nextOccurrenceNumber || record.nextIntendedDate !== (old.tombstoned ? old.nextIntendedDate : nextAfterResolution(record.rule, item.occurrenceResolvedUtc))) fail('Resolution must atomically update the occurrence and template cursor.');
      return;
    }
    fail('Recurrence cursors may change only with a linked occurrence transition.');
  }
  if (record.type !== 'item') return;
  const linked = record.recurrenceTemplateId || old?.recurrenceTemplateId;
  if (!linked) {
    if (['recurrenceTemplateId', 'recurrenceNumber', 'intendedDate', 'sourceTemplateVersion', 'occurrenceState', 'occurrenceResolvedUtc'].some(name => name in (mutation.fields || {}))) fail('Ordinary items cannot forge recurrence fields.');
    return;
  }
  if (record.deleted) fail('A live recurring occurrence must be completed or skipped, not deleted.');
  const template = proposed[`recurrenceTemplate:${linked}`];
  if (!template) fail('Recurring occurrence requires its template.');
  if (!old) {
    if (template.openOccurrenceId !== record.id || record.id !== occurrenceId(linked, record.recurrenceNumber)) fail('Recurring occurrence creation requires the paired template cursor.');
    return;
  }
  for (const name of ['recurrenceTemplateId', 'recurrenceNumber', 'intendedDate', 'sourceTemplateVersion']) if (!same(record[name], old[name])) fail('Recurring occurrence identity and intended date are immutable.');
  if (record.workspaceId !== old.workspaceId && template.workspaceId !== record.workspaceId) fail('Move the recurring template and its history together.');
  if (old.occurrenceState !== 'open') {
    if (Object.keys(mutation.fields).every(name => ['workspaceId', 'collectionRefs', 'listId', 'projectId'].includes(name)) && template.workspaceId === record.workspaceId) return;
    fail('Completed and skipped occurrences are read-only history.');
  }
  if (record.occurrenceState === 'open') {
    if (record.occurrenceResolvedUtc !== null || ['completed', 'dropped'].includes(record.status)) fail('Complete or skip recurring work through its terminal action.');
    return;
  }
  if (!['completed', 'skipped'].includes(record.occurrenceState) || (record.occurrenceState === 'completed' ? record.status !== 'completed' : record.status !== 'dropped') || !record.occurrenceResolvedUtc || template.openOccurrenceId !== null) fail('Occurrence resolution requires the paired template cursor update.');
}

function operationFor(state, accountId, mutations, operationId = crypto.randomUUID()) {
  if (!mutations.length || mutations.length > MAX_OPERATION_MUTATIONS) throw new Error('Save 1–20 records at a time.');
  const records = projected(state);
  const proposed = { ...records };
  for (const mutation of mutations) {
    proposed[key(mutation)] = { ...records[key(mutation)], ...mutation.fields, ...mutation, deleted: mutation.action === 'delete' };
    if (['item', 'recurrenceTemplate'].includes(mutation.type)) normalizeMembership(proposed[key(mutation)], records[key(mutation)], mutation.fields);
  }
  for (const mutation of mutations) {
    if (!['workspace', 'settings'].includes(mutation.type)) {
      const record = proposed[key(mutation)], old = records[key(mutation)];
      if (['item', 'list', 'project', 'savedView', 'review', 'recurrenceTemplate'].includes(record.type) && typeof record.workspaceId !== 'string') throw new Error('workspaceId is required.');
      if (['item', 'recurrenceTemplate'].includes(record.type) && !Array.isArray(record.collectionRefs)) throw new Error('collectionRefs is required.');
      if (record.type === 'project' && !['draft', 'active', 'someday', 'completed'].includes(record.status)) throw new Error('Choose a draft, active, someday or completed project status.');
      if (record.type === 'project' && record.status !== 'draft' && !record.outcome?.trim()) throw new Error('Add a desired outcome before activating this project.');
      if (record.type === 'savedView') {
        if (typeof record.title !== 'string' || !record.title.trim() || record.title.length > 200) throw new Error('Saved view name must be 1–200 characters.');
        if (typeof record.query !== 'string' || record.query.length > 200) throw new Error('Saved view search must be at most 200 characters.');
        if (!['all', 'item', 'list', 'project'].includes(record.resultType)) throw new Error('Choose a supported saved view type.');
        if (!['active', 'all', 'archived'].includes(record.resultState) && !/^status:[^\s][\s\S]{0,63}$/.test(record.resultState || '')) throw new Error('Choose a supported saved view state.');
      }
      if (isCollection(record) && record.archived !== undefined && typeof record.archived !== 'boolean') throw new Error('archived must be true or false.');
      for (const member of [record, ...(old ? [old] : [])]) {
        const id = workspaceOf(member, proposed), workspace = proposed['workspace:' + id];
        if (id !== 'personal' && (!workspace || workspace.deleted || workspace.archived)) throw new Error('This workspace is unavailable or archived. Restore or unarchive it before saving.');
      }
      if (!record.deleted) {
        const refs = ['item', 'recurrenceTemplate'].includes(record.type) ? memberships(record) : record.parentRef ? [record.parentRef] : [];
        const retained = new Set(['item', 'recurrenceTemplate'].includes(record.type) ? memberships(old).map(refKey) : old?.parentRef ? [refKey(old.parentRef)] : []);
        for (const ref of refs) {
          const parent = proposed[refKey(ref)];
          if (!parent || parent.deleted) throw new Error('Destination collection is unavailable. Restore or remove its link.');
          if (workspaceOf(parent, proposed) !== workspaceOf(record, proposed)) throw new Error('Clear collection memberships before moving to another workspace.');
          if (!retained.has(refKey(ref)) && archivedAncestor(ref, proposed)) throw new Error('Archived collections cannot receive new items or child collections. Reactivate it or choose an active destination.');
        }
        if (isCollection(record) && record.parentRef && ancestry(record.parentRef, proposed).some(ref => refKey(ref) === key(record))) throw new Error('A collection cannot be its own ancestor.');
      } else if (isCollection(record) && Object.values(proposed).some(child => collectionContents(child, record))) throw new Error('Move or unlink items and child collections before deleting this collection.');
    }
    if (mutation.type === 'item' && mutation.action !== 'delete') {
      const old = records[key(mutation)];
      validateWorkflow({ ...old, ...mutation.fields }, old, mutation.fields);
    }
    validateRecurrenceMutation(mutation, proposed[key(mutation)], records[key(mutation)], proposed, records);
  }
  validateProjectPlanOperation(mutations, records, proposed);
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
  const empty = { workspaceId: 'personal', title: '', description: '', outcome: '', status: record.type === 'project' ? 'active' : 'inbox', waitingOn: '', contexts: [], areas: [], referenceLinks: [], collectionRefs: [], parentRef: null, kind: 'list', revisitDate: null };
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

export function undoEdit(state, accountId, operationId, now = Date.now(), relatedMutations = []) {
  if (state.undoEdit?.operationId !== operationId || !canUndoEdit(state, now)) {
    throw new Error('This edit can no longer be undone. It expired, the record changed, or a save needs attention.');
  }
  const { type, id, expectedVersion, fields } = state.undoEdit;
  enqueue(state, accountId, [{ type, id, action: 'update', expectedVersion, fields: structuredClone(fields) }, ...relatedMutations]);
  delete state.undoEdit;
}

export function applyReceipt(state, receipt, accountId) {
  if (receipt.apiVersion !== 1 || receipt.accountId !== accountId || !['committed', 'conflict'].includes(receipt.status)) {
    throw new Error('Unexpected acknowledgement. Pending work has been kept.');
  }
  if (receipt.erasedWorkspaces !== undefined && (!Array.isArray(receipt.erasedWorkspaces) || receipt.erasedWorkspaces.some(entry =>
    typeof entry?.workspaceId !== 'string' || entry.workspaceId === PERSONAL || !Number.isFinite(Date.parse(entry.erasedUtc))))) {
    throw new Error('Unexpected workspace erasure acknowledgement. Pending work has been kept.');
  }
  for (const entry of receipt.erasedWorkspaces || []) purgeWorkspaceState(state, entry.workspaceId, entry.erasedUtc);
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
    state.queue[index].failure = state.queue[index].operation.mutations.some(mutation => mutation.type === 'recurrenceTemplate' || mutation.fields?.recurrenceTemplateId)
      ? 'This recurring series changed on another device. Keep the server outcome or export this pending intent before discarding it.'
      : 'Another edit or deletion conflicts with this save. Review both versions.';
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
