import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents, startServer } from './harness.mjs';

test('matrix preference-only writes and legacy defaults writes preserve the other saved field', async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  const principal = Buffer.from(JSON.stringify({ userId: 'alice', userRoles: ['authenticated'] })).toString('base64');
  const write = async (id, expectedVersion, fields) => {
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json', 'x-ms-client-principal': principal }, body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: id, mutations: [{ type: 'settings', id: 'settings', action: expectedVersion ? 'update' : 'create', expectedVersion, fields }] }) });
    assert.equal(response.status, 200); return (await response.json()).records[0];
  };
  const first = await write('matrix-create', 0, { eisenhowerPriority: true }); assert.equal(first.eisenhowerPriority, true); assert.deepEqual(first.defaults.priority, ['P1', 'P2', 'P3', 'P4', 'P5']);
  const defaults = { ...first.defaults, priority: ['Custom'] };
  const second = await write('legacy-defaults', first.version, { defaults }); assert.equal(second.eisenhowerPriority, true); assert.deepEqual(second.defaults, defaults);
  const third = await write('matrix-only', second.version, { eisenhowerPriority: false }); assert.equal(third.eisenhowerPriority, false); assert.deepEqual(third.defaults, defaults);
});
