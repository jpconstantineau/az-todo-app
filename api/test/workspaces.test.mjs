import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents, faults, startServer } from './harness.mjs';
import { workspaceOf, workspaceRecords, workspaceDraft } from '../../html/workspaces.js';
import { collectionMoveMutations, collectionMovePlan, nextCollectionMoveOperation } from '../../html/workspace-move.js';
import { currentCreate } from './current-record.mjs';

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
const create = currentCreate;
const change = (type, id, expectedVersion, fields, action = 'update') => ({ type, id, action, expectedVersion, ...(fields ? { fields } : {}) });
const clarification = (step = 'classify') => ({ flowVersion: 3, step, decision: null, proposal: {
  view: 'classify', mode: 'file', title: 'Report', parentRef: null, search: '', status: 'next', waitingOn: '', reviewDate: '', startDate: '', plannedDay: ''
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

test('workspaces: canonical membership, review scope, foreign IDs and item moves are validated', async t => {
  const { post, setUser } = await setup(t);
  await post([create('workspace', 'work', { title: 'Work' }), create('workspace', 'family', { title: 'Family' })]);
  await post([create('list', 'list', { title: 'Work list', workspaceId: 'work' }), create('project', 'project', { title: 'Project', outcome: 'Done', workspaceId: 'work' })]);
  assert.equal((await post([{ type: 'item', id: 'sparse', action: 'create', expectedVersion: 0, fields: { title: 'Sparse' } }])).status, 400);
  for (const fields of [{ workspaceId: 'missing' }, { listId: 'list' }, { projectId: 'project', workspaceId: 'family' }]) {
    assert.equal((await post([create('item', 'bad', { title: 'Bad', ...fields })])).status, 400);
  }
  assert.equal((await post([create('item', 'task', { title: 'Report', workspaceId: 'work', listId: 'list', projectId: 'project' })])).status, 200);
  assert.equal((await post([change('item', 'task', 1, { workspaceId: 'family' })])).status, 400);
  assert.equal((await post([create('review', 'bad-review', { reviewKind: 'weekly', reviewDay: '2026-10-03', included: [{ type: 'item', id: 'task' }], decisionHeads: [null], decisionCount: 0, workspaceId: 'family' })])).status, 400);
  assert.equal((await post([change('item', 'task', 1, { workspaceId: 'family', listId: null, projectId: null })])).status, 200);
  const records = Object.fromEntries(documents.filter(row => row.kind === 'record').map(row => [`${row.record.type}:${row.record.id}`, row.record]));
  records['clarification:task'] = { type: 'clarification', id: 'task', ...clarification() };
  records['brief:brief'] = { type: 'brief', id: 'brief', subjectType: 'item', subjectId: 'task' };
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

test('workspaces: large collection moves detach, move and reattach in repeat-safe bounded batches', async t => {
  const { post } = await setup(t);
  assert.equal((await post([
    create('workspace', 'work', { title: 'Work' }), create('workspace', 'family', { title: 'Family' }),
    create('list', 'root', { title: 'Root', workspaceId: 'work' }), create('list', 'other', { title: 'Other', workspaceId: 'work' })
  ])).status, 200);
  for (let start = 0; start < 21; start += 20) {
    const batch = Array.from({ length: Math.min(20, 21 - start) }, (_, offset) => {
      const id = `task-${start + offset}`;
      return create('item', id, { title: id, originalText: `Original ${id}`, workspaceId: 'work', listId: 'other',
        collectionRefs: [{ type: 'list', id: 'root' }, { type: 'list', id: 'other' }] });
    });
    assert.equal((await post(batch)).status, 200);
  }
  const read = () => Object.fromEntries(documents.filter(row => row.kind === 'record').map(row => [`${row.record.type}:${row.record.id}`, row.record]));
  let records = read();
  const plan = collectionMovePlan(records['list:root'], 'family', records, { title: 'Moved root', workspaceId: 'family', parentRef: null }, 'large-move');
  assert.equal(plan.entries.length, 22);
  assert.equal(collectionMovePlan(records['list:root'], 'family',
    Object.fromEntries(Object.entries(records).filter(([id]) => id === 'list:root' || id.startsWith('workspace:') || /^item:task-(?:[0-9]|1[0-8])$/.test(id))),
    { title: 'Moved root', workspaceId: 'family', parentRef: null }), null, '20 affected records retain the atomic path');
  const phases = [];
  let lost = false;
  while (true) {
    const next = nextCollectionMoveOperation(plan, records, 'alice');
    if (!next) break;
    assert.ok(next.operation.mutations.length <= 20);
    phases.push(next.phase);
    if (!lost) {
      lost = true; faults.loseBatchResponse = true;
      assert.equal((await post(next.operation.mutations, { operationId: next.operation.operationId })).status, 503);
    }
    assert.equal((await post(next.operation.mutations, { operationId: next.operation.operationId })).status, 200);
    records = read();
    for (const record of Object.values(records).filter(record => !record.deleted)) {
      for (const ref of record.type === 'item' ? record.collectionRefs : record.parentRef ? [record.parentRef] : []) {
        assert.equal(records[`${ref.type}:${ref.id}`].workspaceId, record.workspaceId, 'an intermediate batch cannot expose a cross-workspace relationship');
      }
    }
  }
  assert.deepEqual([...new Set(phases)], ['detach', 'move', 'attach']);
  assert.equal(records['list:root'].title, 'Moved root');
  for (let index = 0; index < 21; index++) {
    const item = records[`item:task-${index}`];
    assert.equal(item.workspaceId, 'family');
    assert.equal(item.originalText, `Original task-${index}`);
    assert.deepEqual(item.collectionRefs, [{ type: 'list', id: 'root' }]);
    assert.equal(item.listId, 'root');
  }
  assert.equal(records['list:other'].workspaceId, 'work');
});

test('workspaces: 20 is an operation boundary, not a logical collection-move limit', () => {
  let records = {
    'workspace:work': { type: 'workspace', id: 'work', title: 'Work', version: 1 },
    'workspace:family': { type: 'workspace', id: 'family', title: 'Family', version: 1 },
    'list:root': { type: 'list', id: 'root', title: 'Root', workspaceId: 'work', version: 1 }
  };
  for (let index = 0; index < 1000; index++) records[`item:task-${index}`] = {
    type: 'item', id: `task-${index}`, title: `Task ${index}`, workspaceId: 'work', version: 1,
    listId: 'root', projectId: null, collectionRefs: [{ type: 'list', id: 'root' }]
  };
  const plan = collectionMovePlan(records['list:root'], 'family', records,
    { title: 'Root', workspaceId: 'family', parentRef: null }, 'thousand-item-move');
  assert.equal(plan.entries.length, 1001, '1,000 linked items plus their root are one logical move');

  const phases = [];
  while (true) {
    const next = nextCollectionMoveOperation(plan, records, 'alice');
    if (!next) break;
    assert.ok(next.operation.mutations.length >= 1 && next.operation.mutations.length <= 20);
    assert.ok(new TextEncoder().encode(JSON.stringify(next.operation)).length <= 64 * 1024);
    phases.push(next.phase);
    records = structuredClone(records);
    for (const mutation of next.operation.mutations) Object.assign(records[`${mutation.type}:${mutation.id}`], mutation.fields, {
      version: mutation.expectedVersion + 1
    });
  }
  assert.deepEqual([...new Set(phases)], ['detach', 'move', 'attach']);
  assert.ok(phases.length > 3, 'the logical move spans many bounded operations');
  assert.equal(records['list:root'].workspaceId, 'family');
  assert.equal(records['item:task-999'].workspaceId, 'family');
  assert.deepEqual(records['item:task-999'].collectionRefs, [{ type: 'list', id: 'root' }]);
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
  assert.equal((await post([create('review', 'review', { reviewKind: 'weekly', reviewDay: '2026-10-03', included: [], decisionHeads: [], decisionCount: 0, workspaceId: 'work' })])).status, 400);
  assert.equal(documents.length, count, 'rejected derived writes leave no partial records or receipts');
  for (const fields of [{ title: '' }, { title: 'x'.repeat(201) }, { title: 'Valid', archived: 'yes' }, { title: 'Valid', surprise: true }]) {
    assert.equal((await post([create('workspace', 'invalid', fields)])).status, 400);
  }
});
