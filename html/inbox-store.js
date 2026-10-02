const empty = () => ({ records: {}, queue: [], after: 0, draft: {} });
export const key = record => `${record.type}:${record.id}`;
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
let connection;
function database() {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('todo-inbox-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = null; reject(request.error); };
  });
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
      records[id] = { ...records[id], ...mutation.fields, type: mutation.type, id: mutation.id,
        version: mutation.expectedVersion + 1, deleted: false,
        localState: entry.failure ? 'Failed — needs attention' : 'Saved on device — pending' };
    }
  }
  return records;
}

export function enqueue(state, accountId, mutations) {
  if (!mutations.length || mutations.length > 20) throw new Error('Save 1–20 items at a time (19 with a new list).');
  const operation = { apiVersion: 1, accountId, operationId: crypto.randomUUID(), mutations };
  if (size(operation) > 65536) throw new Error('This capture is too large. Save fewer items at a time. Your text is still here.');
  // ponytail: one account document; split stores if measured cache size makes transactions slow.
  if (state.queue.length >= 100 || size(state.queue) + size(operation) > 5 * 1024 * 1024) {
    throw new Error('The device queue is full (100 saves or 5 MiB). Sync or export pending work before adding more.');
  }
  state.queue.push({ operation });
}

export function applyReceipt(state, receipt, accountId) {
  if (receipt.apiVersion !== 1 || receipt.accountId !== accountId || !['committed', 'conflict'].includes(receipt.status)) {
    throw new Error('Unexpected acknowledgement. Pending work has been kept.');
  }
  for (const record of receipt.records) {
    if (record.accountId !== accountId) throw new Error('Account mismatch in response.');
    if ((state.records[key(record)]?.version ?? 0) < record.version) state.records[key(record)] = record;
  }
  const index = state.queue.findIndex(entry => entry.operation.operationId === receipt.operationId);
  if (index < 0) return;
  if (receipt.status === 'committed') state.queue.splice(index, 1);
  else {
    state.queue[index].failure = 'Another edit or deletion conflicts with this save. Review both versions.';
    state.queue[index].receipt = receipt;
    for (const conflict of receipt.conflicts) {
      const record = conflict.current;
      if (record && (state.records[key(record)]?.version ?? 0) < record.version) state.records[key(record)] = record;
    }
  }
}

export function captureMutations(draft) {
  const source = draft.original ?? draft.text ?? '';
  const titles = (draft.text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!titles.length || titles.some(title => title.length > 200)) throw new Error('Enter a title of 1–200 characters on each non-empty line.');
  if (source.length > 16000 || (draft.body ?? '').length > 4000) throw new Error('Capture text is limited to 16,000 characters and notes to 4,000.');
  const mutations = [];
  let listId = draft.listId || null;
  if (draft.newList?.trim()) {
    if (draft.newList.length > 200) throw new Error('List title must be at most 200 characters.');
    listId = crypto.randomUUID();
    mutations.push({ type: 'list', id: listId, action: 'create', expectedVersion: 0,
      fields: { title: draft.newList.trim(), originalText: draft.newList } });
  }
  for (const title of titles) mutations.push({ type: 'item', id: crypto.randomUUID(), action: 'create', expectedVersion: 0,
    fields: { title, description: draft.body || '', originalText: source, listId, status: 'inbox' } });
  return mutations;
}
