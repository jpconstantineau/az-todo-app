import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents, faults, startServer } from './harness.mjs';
import { workspaceOf, workspaceRecords, workspaceDraft } from '../../html/workspaces.js';
import { collectionMoveMutations } from '../../html/workspace-move.js';

async function setup(t) {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  let operation = 0;
  const post = async (mutations, extra = {}) => {
    const body = { apiVersion: 1, accountId: 'alice', operationId: `workspace-op-${++operation}`, mutations, ...extra };
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { post, server, setUser: value => { user = value; } };
}
const create = (type, id, fields) => ({ type, id, action: 'create', expectedVersion: 0, fields });
const change = (type, id, expectedVersion, fields, action = 'update') => ({ type, id, action, expectedVersion, ...(fields ? { fields } : {}) });
const clarification = (step = 'actionable') => ({ flowVersion: 2, step, answers: {}, proposal: {
  text: '', choice: '', projectId: '', projectTitle: '', outcome: '', waitingOn: '', reviewDate: '', startDate: '', plannedDay: '', listId: '', notes: ''
} });

test('workspaces: atomic archive/delete gates all records, preserves history, and restores without rewriting children', async t => {
  const { post } = await setup(t);
  assert.equal((await post([create('workspace', 'work', { title: 'Work' }), create('item', 'task', { title: 'Report', workspaceId: 'work' })])).status, 200);
  await post([create('item', 'personal', { title: 'Milk' })]);
  const original = structuredClone(documents.find(row => row.id === 'record:item:task'));
  await post([change('workspace', 'work', 1, { archived: true })]);
  for (const mutation of [change('item', 'task', 1, { title: 'Stale edit' }), create('item', 'new', { title: 'Late capture', workspaceId: 'work' }), create('clarification', 'task', clarification()), change('item', 'task', 1, null, 'delete')]) {
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
  const { post, setUser } = await setup(t);
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
  records['clarification:task'] = { type: 'clarification', id: 'task', ...clarification() };
  records['brief:brief'] = { type: 'brief', id: 'brief', subjectType: 'item', subjectId: 'task' };
  assert.equal(workspaceOf(records['item:legacy'], records), 'personal');
  assert.deepEqual(Object.keys(workspaceRecords(records, 'family')).sort(), ['brief:brief', 'clarification:task', 'item:task']);
  assert.equal(workspaceRecords(records, 'work')['item:task'], undefined);
  records['workspace:family'].deleted = true;
  assert.deepEqual(workspaceRecords(records, 'family'), {});
  assert.equal((await post([create('item', 'foreign', { title: 'Other account', workspaceId: 'work' })], { accountId: 'bob' })).status, 409);
  setUser('bob');
  assert.equal((await post([create('item', 'foreign', { title: 'Other account', workspaceId: 'work' })], { accountId: 'bob' })).status, 400);
  assert.equal((await post([change('workspace', 'work', 1, { archived: true })], { accountId: 'bob' })).status, 409);
  const state = { draft: { capture: { text: 'Legacy' } } };
  assert.equal(workspaceDraft(state, 'personal'), state.draft);
  workspaceDraft(state, '__proto__').capture = { text: 'Safe workspace ID' };
  assert.equal(Object.prototype.capture, undefined);
  assert.equal(workspaceDraft(structuredClone(state), '__proto__').capture.text, 'Safe workspace ID');
});

test('workspaces: moving a collection carries its nested records and keeps history IDs', async t => {
  const { post } = await setup(t);
  assert.equal((await post([
    create('workspace', 'work', { title: 'Work' }), create('workspace', 'family', { title: 'Family' }),
    create('list', 'root', { title: 'Root', workspaceId: 'work' }),
    create('project', 'child', { title: 'Project', outcome: 'Done', workspaceId: 'work', parentRef: { type: 'list', id: 'root' } }),
    create('list', 'other', { title: 'Other', workspaceId: 'work' }),
    create('item', 'task', { title: 'Clarified task', workspaceId: 'work', collectionRefs: [{ type: 'project', id: 'child' }, { type: 'list', id: 'other' }], projectId: 'child', listId: 'other' })
  ])).status, 200);
  const records = Object.fromEntries(documents.filter(row => row.kind === 'record').map(row => [`${row.record.type}:${row.record.id}`, row.record]));
  records['clarification:task'] = { type: 'clarification', id: 'task', ...clarification('complete') };
  records['brief:brief'] = { type: 'brief', id: 'brief', subjectType: 'item', subjectId: 'task' };
  const mutations = collectionMoveMutations(records['list:root'], 'family', records, { title: 'Root renamed', workspaceId: 'family', parentRef: null });
  assert.deepEqual(mutations.map(mutation => `${mutation.type}:${mutation.id}`).sort(), ['item:task', 'list:root', 'project:child']);
  assert.equal((await post([change('list', 'root', 1, { workspaceId: 'family' })])).status, 400, 'a direct API move cannot strand contents');
  assert.equal((await post(mutations)).status, 200);
  const moved = Object.fromEntries(documents.filter(row => row.kind === 'record').map(row => [`${row.record.type}:${row.record.id}`, row.record]));
  assert.equal(moved['list:root'].title, 'Root renamed');
  assert.equal(moved['project:child'].workspaceId, 'family');
  assert.deepEqual(moved['project:child'].parentRef, { type: 'list', id: 'root' });
  assert.deepEqual(moved['item:task'].collectionRefs, [{ type: 'project', id: 'child' }]);
  assert.equal(moved['item:task'].listId, null);
  assert.equal(moved['item:task'].projectId, 'child');
  assert.equal(moved['list:other'].workspaceId, 'work');
  moved['clarification:task'] = records['clarification:task']; moved['brief:brief'] = records['brief:brief'];
  assert.equal(workspaceOf(moved['clarification:task'], moved), 'family');
  assert.equal(workspaceOf(moved['brief:brief'], moved), 'family');
});

test('workspaces: concurrent archive and capture serialize; frozen workspace rejects derived history changes', async t => {
  const { post } = await setup(t);
  await post([create('workspace', 'work', { title: 'Work' }), create('item', 'task', { title: 'Report', workspaceId: 'work' })]);
  const content = Object.fromEntries(['outcome', 'context', 'scope', 'exclusions', 'nextAction', 'acceptanceChecks', 'missingInformation'].map(name => [name, 'Supplied text']));
  await post([create('brief', 'brief', { subjectType: 'item', subjectId: 'task', sourceVersion: 1, previousBriefId: null, content, status: 'draft' })]);
  const [archived, capture] = await Promise.all([
    post([change('workspace', 'work', 1, { archived: true })]),
    post([create('item', 'racing', { title: 'Racing capture', workspaceId: 'work' })])
  ]);
  assert.equal(archived.status, 200);
  assert.ok([200, 400].includes(capture.status));
  if (capture.status === 200) assert.ok(capture.body.sequence < archived.body.sequence);
  const count = documents.length;
  assert.equal((await post([change('brief', 'brief', 1, { status: 'accepted' })])).status, 400);
  assert.equal((await post([create('review', 'review', { reviewKind: 'weekly', reviewDay: '2026-10-03', included: [], decisions: [], workspaceId: 'work' })])).status, 400);
  assert.equal(documents.length, count, 'rejected derived writes leave no partial records or receipts');
  for (const fields of [{ title: '' }, { title: 'x'.repeat(201) }, { title: 'Valid', archived: 'yes' }, { title: 'Valid', surprise: true }]) {
    assert.equal((await post([create('workspace', 'invalid', fields)])).status, 400);
  }
});
