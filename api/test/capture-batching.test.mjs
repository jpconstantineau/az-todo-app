import test from 'node:test';
import assert from 'node:assert/strict';
import { captureMutations, enqueueCapture, projected } from '../../html/inbox-store.js';

const empty = () => ({ records: {}, queue: [], after: 0, draft: {} });
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

test('manual capture accepts 1,000 items and packs a new list into ordered v1 operations', () => {
  const state = empty(), source = Array(1000).fill('x').join('\n');
  const mutations = captureMutations({ text: source, newList: 'Bulk capture' });

  assert.equal(mutations.length, 1001);
  const batchCount = enqueueCapture(state, 'alice', mutations);
  assert.equal(batchCount, state.queue.length);
  assert.ok(batchCount >= 51 && batchCount <= 1001);
  assert.equal(state.queue.reduce((total, entry) => total + entry.operation.mutations.length, 0), 1001);
  assert.ok(state.queue.every(entry => entry.operation.mutations.length >= 1 && entry.operation.mutations.length <= 20 && bytes(entry.operation) <= 65536));
  assert.equal(state.queue[0].operation.mutations[0].type, 'list');
  assert.ok(state.queue.slice(1).every(entry => entry.operation.mutations.every(mutation => mutation.type === 'item')));

  const records = Object.values(projected(state));
  assert.equal(records.filter(record => record.type === 'item').length, 1000);
  assert.equal(records.find(record => record.type === 'list').title, 'Bulk capture');
  assert.ok(records.filter(record => record.type === 'item').every(record => record.originalText === source));
});

test('manual capture rejects 1,001 items before queueing and capacity preflight changes nothing', () => {
  assert.throws(() => captureMutations({ text: Array(1001).fill('x').join('\n') }), /up to 1,000/);

  const state = empty(), mutation = captureMutations({ text: 'Keep this' });
  state.queue = Array.from({ length: 1024 }, () => ({ operation: { apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [] } }));
  const before = structuredClone(state.queue);
  assert.throws(() => enqueueCapture(state, 'alice', mutation), /room for 0/);
  assert.deepEqual(state.queue, before);
});
