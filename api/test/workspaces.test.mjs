import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents, faults, startServer } from './harness.mjs';
import { workspaceOf, workspaceRecords } from '../../html/workspaces.js';

async function setup(t) {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  let operation = 0;
  const post = async (mutations, extra = {}) => {
    const body = { apiVersion: 1, accountId: 'alice', operationId: `workspace-op-${++operation}`, mutations, ...extra };
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { post, server };
}
const create = (type, id, fields) => ({ type, id, action: 'create', expectedVersion: 0, fields });
const change = (type, id, expectedVersion, fields, action = 'update') => ({ type, id, action, expectedVersion, ...(fields ? { fields } : {}) });

test('workspaces: atomic archive/delete gates all records, preserves history, and restores without rewriting children', async t => {
  const { post } = await setup(t);
  assert.equal((await post([create('workspace', 'work', { title: 'Work' }), create('item', 'task', { title: 'Report', workspaceId: 'work' })])).status, 200);
  await post([create('item', 'personal', { title: 'Milk' })]);
  const original = structuredClone(documents.find(row => row.id === 'record:item:task'));
  await post([change('workspace', 'work', 1, { archived: true })]);
  for (const mutation of [change('item', 'task', 1, { title: 'Stale edit' }), create('item', 'new', { title: 'Late capture', workspaceId: 'work' }), create('clarification', 'task', { step: 0, answers: {}, proposal: null }), change('item', 'task', 1, null, 'delete')]) {
    assert.equal((await post([mutation])).status, 400);
  }
  assert.equal((await post([change('item', 'personal', 1, { title: 'Eggs' })])).status, 200);
  await post([change('workspace', 'work', 2, { archived: false })]);
  faults.loseBatchResponse = true;
  const deletion = [change('workspace', 'work', 3, null, 'delete')];
  assert.equal((await post(deletion, { operationId: 'delete-work' })).status, 503);
  const result = await post(deletion, { operationId: 'delete-work' });
  assert.equal(result.status, 200);
  assert.deepEqual(await post(deletion, { operationId: 'delete-work' }), result);
  assert.equal((await post([change('item', 'task', 1, { title: 'Late' })])).status, 400);
  assert.deepEqual(documents.find(row => row.id === original.id), original);
  assert.equal((await post([change('workspace', 'work', 3, null, 'restore')])).status, 409);
  assert.equal((await post([change('workspace', 'work', 4, null, 'restore')])).status, 200);
  assert.equal((await post([change('item', 'task', 1, { title: 'Resumed' })])).status, 200);
  assert.equal((await post([create('workspace', 'personal', { title: 'Hijack default' })])).status, 400);
});

test('workspaces: membership, review scope, foreign IDs, item moves and legacy Personal are validated', async t => {
  const { post } = await setup(t);
  await post([create('workspace', 'work', { title: 'Work' }), create('workspace', 'family', { title: 'Family' })]);
  await post([create('list', 'list', { title: 'Work list', workspaceId: 'work' }), create('project', 'project', { title: 'Project', outcome: 'Done', workspaceId: 'work' })]);
  for (const fields of [{ workspaceId: 'missing' }, { listId: 'list' }, { projectId: 'project', workspaceId: 'family' }]) {
    assert.equal((await post([create('item', 'bad', { title: 'Bad', ...fields })])).status, 400);
  }
  assert.equal((await post([create('item', 'task', { title: 'Report', workspaceId: 'work', listId: 'list', projectId: 'project' })])).status, 200);
  assert.equal((await post([change('item', 'task', 1, { workspaceId: 'family' })])).status, 400);
  assert.equal((await post([create('review', 'bad-review', { reviewKind: 'weekly', reviewDay: '2026-10-03', included: [{ type: 'item', id: 'task' }], decisions: [], workspaceId: 'family' })])).status, 400);
  assert.equal((await post([change('item', 'task', 1, { workspaceId: 'family', listId: null, projectId: null })])).status, 200);
  const records = Object.fromEntries(documents.filter(row => row.kind === 'record').map(row => [`${row.record.type}:${row.record.id}`, row.record]));
  records['item:legacy'] = { type: 'item', id: 'legacy', title: 'Old task' };
  records['clarification:task'] = { type: 'clarification', id: 'task' };
  records['brief:brief'] = { type: 'brief', id: 'brief', subjectType: 'item', subjectId: 'task' };
  assert.equal(workspaceOf(records['item:legacy'], records), 'personal');
  assert.deepEqual(Object.keys(workspaceRecords(records, 'family')).sort(), ['brief:brief', 'clarification:task', 'item:task']);
  assert.equal(workspaceRecords(records, 'work')['item:task'], undefined);
  records['workspace:family'].deleted = true;
  assert.deepEqual(workspaceRecords(records, 'family'), {});
  assert.equal((await post([create('item', 'foreign', { title: 'Other account', workspaceId: 'work' })], { accountId: 'bob' })).status, 409);
});
