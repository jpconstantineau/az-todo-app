import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projected, enqueue, applyReceipt } from '../../html/inbox-store.js';
import { deviceExport } from '../../html/inbox-export.js';

const record = (type = 'item') => ({ accountId: 'alice', type, id: 'one', version: 1,
  deleted: false, title: 'Original', originalText: '  Original\n', status: 'inbox' });
const stateFor = value => ({ records: { [`${value.type}:${value.id}`]: value }, queue: [], after: 0, draft: {} });
const mutation = (value, action, fields) => ({ type: value.type, id: value.id, action,
  expectedVersion: value.version, ...(fields ? { fields } : {}) });

test('only a matching explicit restore projects a tombstone active and survives export/reload', () => {
  const original = record(), state = stateFor(original);
  enqueue(state, 'alice', [mutation(original, 'delete')]);
  const deleted = projected(state)['item:one'];
  enqueue(state, 'alice', [mutation(deleted, 'restore')]);
  const restored = projected(state)['item:one'];
  assert.equal(restored.deleted, false); assert.equal(restored.deletedUtc, null); assert.equal(restored.version, 3);
  assert.equal(restored.originalText, original.originalText);
  assert.deepEqual(projected(JSON.parse(JSON.stringify(deviceExport('alice', state, {}).state))), projected(state));
  const tombstone = { ...original, version: 4, deleted: true };
  state.records['item:one'] = tombstone;
  assert.deepEqual(projected(state)['item:one'], tombstone, 'a later server delete blocks the earlier restore');
  state.queue = [];
  enqueue(state, 'alice', [mutation(tombstone, 'restore')]);
  state.queue[0].failure = 'Rejected restore';
  assert.deepEqual(projected(state)['item:one'], tombstone, 'failed restore remains inactive');
});

test('queued deletions stay inactive across serialization, acknowledgement and discard for every deletable type', () => {
  for (const type of ['item', 'list', 'project', 'clarification', 'review', 'brief']) {
    const original = record(type), state = stateFor(original), id = `${type}:one`;
    enqueue(state, 'alice', [mutation(original, 'delete')]);
    const before = structuredClone(state);
    const deleted = projected(JSON.parse(JSON.stringify(state)))[id];
    assert.equal(deleted.deleted, true, type);
    assert.equal(deleted.version, 2);
    assert.equal(deleted.originalText, original.originalText);
    assert.match(deleted.localState, /pending/);
    assert.deepEqual(state, before, 'projection must not mutate confirmed records or pending intent');
    const exported = deviceExport('alice', state, {});
    assert.equal(exported.state.records[id].deleted, false, 'export keeps the confirmed snapshot separate');
    assert.deepEqual(exported.state.queue, before.queue);
    const discarded = structuredClone(state);
    discarded.queue = [];
    assert.equal(projected(discarded)[id].deleted, false, 'discarding an uncommitted delete restores the confirmed view');
    const tombstone = { ...original, version: 2, deleted: true, deletedUtc: '2026-10-03T00:00:00.000Z' };
    applyReceipt(state, { apiVersion: 1, accountId: 'alice', operationId: state.queue[0].operation.operationId,
      status: 'committed', records: [tombstone] }, 'alice');
    assert.equal(state.queue.length, 0);
    assert.deepEqual(projected(state)[id], tombstone);
  }
});

test('stale queued edits cannot replace a server tombstone, even before conflict acknowledgement', () => {
  const original = record(), state = stateFor(original);
  enqueue(state, 'alice', [mutation(original, 'update', { title: 'Recover this unsynced text' })]);
  const operation = structuredClone(state.queue[0].operation);
  const tombstone = { ...original, version: 3, deleted: true, deletedUtc: '2026-10-03T00:00:00.000Z' };
  applyReceipt(state, { apiVersion: 1, accountId: 'alice', operationId: 'other-device-delete',
    status: 'committed', records: [tombstone] }, 'alice');
  assert.deepEqual(projected(state)['item:one'], tombstone);
  applyReceipt(state, { apiVersion: 1, accountId: 'alice', operationId: operation.operationId,
    status: 'conflict', records: [], proposed: operation.mutations,
    conflicts: [{ proposed: operation.mutations[0], current: tombstone }] }, 'alice');
  assert.deepEqual(projected(state)['item:one'], tombstone);
  assert.deepEqual(state.queue[0].operation, operation, 'stale text stays recoverable in the exact queued operation');
  assert.match(state.queue[0].failure, /conflicts/);
});

test('later queued updates cannot reactivate a pending delete; ordinary create/update projection still works', () => {
  const state = { records: {}, queue: [], after: 0, draft: {} };
  enqueue(state, 'alice', [{ type: 'item', id: 'one', action: 'create', expectedVersion: 0,
    fields: { title: 'Original', originalText: 'Original', status: 'inbox' } }]);
  let current = projected(state)['item:one'];
  assert.equal(current.deleted, false);
  enqueue(state, 'alice', [mutation(current, 'update', { title: 'Edited' })]);
  current = projected(state)['item:one'];
  assert.equal(current.title, 'Edited');
  assert.equal(current.version, 2);
  enqueue(state, 'alice', [mutation(current, 'delete')]);
  const deleted = projected(state)['item:one'];
  enqueue(state, 'alice', [mutation(deleted, 'update', { title: 'Stale later edit' })]);
  assert.deepEqual(projected(state)['item:one'], deleted);
  assert.equal(state.queue.length, 4, 'projection never silently discards recoverable intent');
});
