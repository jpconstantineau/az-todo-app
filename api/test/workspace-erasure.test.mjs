import { test } from 'node:test';
import assert from 'node:assert/strict';
import { container, documents, startServer } from './harness.mjs';
import { applyWorkspaceErasure, createWorkspaceErasurePlan, erasureMarkerId, WorkspaceErasureError } from '../api/v1/workspace-erasure.mjs';
import { applyReceipt } from '../../html/inbox-store.js';
import { accountExport } from '../../html/inbox-export.js';

const create = (type, id, fields) => ({ type, id, action: 'create', expectedVersion: 0, fields: {
  ...(type === 'item' ? { collectionRefs: [] } : {}), ...(type === 'project' ? { status: 'active' } : {}), ...fields
} });

async function setup(t) {
  documents.length = 0;
  let user = 'alice', operation = 0;
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const post = async (mutations, extra = {}) => {
    const payload = { apiVersion: 1, accountId: user, operationId: `erase-test-${user}-${++operation}`, mutations, ...extra };
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json(), payload };
  };
  return { server, post, user: value => { user = value; } };
}

test('workspace erasure: private dry run, resumable purge, isolation and stale-write fence', async t => {
  const { post, user, server } = await setup(t);
  const mixed = await post([
    create('workspace', 'work', { title: 'Former employer secret' }),
    create('workspace', 'family', { title: 'Family' }),
    create('item', 'work-task', { title: 'Confidential report', originalText: 'Private task text', workspaceId: 'work' }),
    create('project', 'work-project', { title: 'Close project', outcome: 'Closed', workspaceId: 'work' }),
    create('savedView', 'work-view', { title: 'Employer search', workspaceId: 'work', query: 'secret', resultType: 'all', resultState: 'all' }),
    create('item', 'family-task', { title: 'Buy milk', workspaceId: 'family' })
  ]);
  assert.equal(mixed.status, 200);
  assert.equal((await post([
    { type: 'project', id: 'work-project', action: 'update', expectedVersion: 1, fields: { planningHeadId: 'work-plan-1' } },
    create('projectPlanRevision', 'work-plan-1', { projectId: 'work-project', sourceVersion: 1, previousRevisionId: null,
      sections: { purposePrinciples: 'Retained purpose', desiredEvidence: '', organizationApproach: '', unresolvedQuestions: '' },
      candidates: [{ id: 'close-action', title: 'Archive files', kind: 'action' }], mappings: [{ candidateId: 'close-action', itemId: 'work-plan-action', kind: 'action' }] }),
    create('item', 'work-plan-action', { title: 'Archive files', workspaceId: 'work', status: 'next', projectId: 'work-project', collectionRefs: [{ type: 'project', id: 'work-project' }] })
  ])).status, 200);
  await post([{ type: 'item', id: 'work-task', action: 'delete', expectedVersion: 1 }]);
  user('bob');
  await post([create('workspace', 'work', { title: 'Bob work' }), create('item', 'work-task', { title: 'Bob task', workspaceId: 'work' })]);
  user('alice');
  const bobBefore = structuredClone(documents.filter(row => row.UserID === 'bob'));
  const familyBefore = structuredClone(documents.find(row => row.UserID === 'alice' && row.id === 'record:item:family-task'));
  const before = structuredClone(documents);
  const plan = createWorkspaceErasurePlan(documents.filter(row => row.UserID === 'alice'), 'alice', 'work', 'erase-work-1');
  assert.deepEqual(documents, before, 'dry run is read-only');
  const evidence = JSON.stringify(plan);
  for (const secret of ['Former employer secret', 'Confidential report', 'Private task text', 'work-task', mixed.payload.operationId]) assert.equal(evidence.includes(secret), false);
  assert.equal(plan.counts.records, 6);
  assert.throws(() => createWorkspaceErasurePlan(documents, 'alice', 'personal'), error => error instanceof WorkspaceErasureError && error.code === 'personal_forbidden');

  await assert.rejects(applyWorkspaceErasure(container, plan, { confirm: plan.erasureId, interruptAfter: 'changes' }), { code: 'interrupted' });
  assert.equal(documents.find(row => row.UserID === 'alice' && row.id === erasureMarkerId('work')).status, 'erasing');
  const escape = await post([{ type: 'item', id: 'work-task', action: 'update', expectedVersion: 2, fields: { workspaceId: 'family' } }]);
  assert.equal(escape.status, 410, 'the fence checks both the old and proposed workspace');
  const result = await applyWorkspaceErasure(container, plan, { confirm: plan.erasureId });
  assert.equal(result.status, 'complete');
  documents.push(...structuredClone(before.filter(row => row.UserID === 'alice' && ['record:workspace:work', 'record:item:work-task', 'record:savedView:work-view'].includes(row.id))));
  assert.equal((await applyWorkspaceErasure(container, plan, { confirm: plan.erasureId })).status, 'complete', 'completed replay verifies and removes restored rows');

  assert.equal(documents.some(row => row.UserID === 'alice' && row.kind === 'record' && ['workspace:work', 'item:work-task', 'project:work-project', 'projectPlanRevision:work-plan-1', 'item:work-plan-action', 'savedView:work-view'].includes(`${row.record.type}:${row.record.id}`)), false);
  assert.deepEqual(documents.find(row => row.UserID === 'alice' && row.id === 'record:item:family-task'), familyBefore);
  assert.deepEqual(documents.filter(row => row.UserID === 'bob'), bobBefore);
  const aliceChanges = documents.filter(row => row.UserID === 'alice' && row.kind === 'change').sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(aliceChanges.map(row => row.sequence), Array.from({ length: aliceChanges.length }, (_, index) => index + 1));
  assert.equal(JSON.stringify(aliceChanges).includes('Private task text'), false);
  assert.ok(aliceChanges.some(row => row.response.records?.some(record => record.id === 'family-task')), 'unaffected part of a mixed change remains');
  const exported = await accountExport('alice', async path => {
    const response = await fetch(`${server.url}/api/v1/${path}`);
    if (!response.ok) throw new Error('export failed');
    return response.json();
  });
  assert.equal(exported.state.records['workspace:work'], undefined);
  assert.equal(exported.state.records['item:work-task'], undefined);
  assert.equal(exported.state.records['savedView:work-view'], undefined);
  assert.equal(exported.state.records['item:family-task'].title, 'Buy milk');

  const sequence = documents.find(row => row.UserID === 'alice' && row.id === 'state').sequence;
  const stale = await post([create('item', 'late-work', { title: 'Late offline save', workspaceId: 'work' })]);
  assert.equal(stale.status, 410); assert.equal(stale.body.error, 'workspace_erased');
  assert.equal(documents.find(row => row.UserID === 'alice' && row.id === 'state').sequence, sequence);
  assert.equal(documents.some(row => row.UserID === 'alice' && row.id === `receipt:${stale.payload.operationId}`), false);
  const restore = await post([{ type: 'workspace', id: 'work', action: 'restore', expectedVersion: 2 }]);
  assert.equal(restore.status, 410);
  assert.equal((await post([create('item', 'family-later', { title: 'Still writable', workspaceId: 'family' })])).status, 200);
});

test('workspace erasure: change signal removes only matching device state and export inputs', () => {
  const state = {
    records: {
      'workspace:work': { type: 'workspace', id: 'work', accountId: 'alice', version: 1, deleted: false },
      'workspace:family': { type: 'workspace', id: 'family', accountId: 'alice', version: 1, deleted: false },
      'item:work': { type: 'item', id: 'work', accountId: 'alice', workspaceId: 'work', version: 1, deleted: false, collectionRefs: [] },
      'clarification:work': { type: 'clarification', id: 'work', accountId: 'alice', version: 1, deleted: false },
      'item:family': { type: 'item', id: 'family', accountId: 'alice', workspaceId: 'family', version: 1, deleted: false, collectionRefs: [] }
    },
    queue: [
      { operation: { operationId: 'mixed', mutations: [{ type: 'item', id: 'work', action: 'update', expectedVersion: 1, fields: { title: 'Offline' } }, { type: 'item', id: 'family', action: 'update', expectedVersion: 1, fields: { title: 'Also offline' } }] } },
      { operation: { operationId: 'family', mutations: [{ type: 'item', id: 'family', action: 'update', expectedVersion: 1, fields: { title: 'Keep' } }] } }
    ],
    draft: {}, workspaceDrafts: { work: { capture: { text: 'Private draft' } }, family: { capture: { text: 'Keep draft' } } },
    selectedWorkspace: 'work', undoEdit: { type: 'item', id: 'work' },
    workspaceMove: { sourceWorkspaceId: 'work', destinationWorkspaceId: 'family' }
  };
  applyReceipt(state, { apiVersion: 1, accountId: 'alice', operationId: 'workspace-erasure-3', sequence: 3,
    status: 'committed', records: [], erasedWorkspaces: [{ workspaceId: 'work', erasedUtc: '2026-10-06T22:00:00.000Z' }] }, 'alice');
  assert.deepEqual(Object.keys(state.records).sort(), ['item:family', 'workspace:family']);
  assert.deepEqual(state.queue.map(entry => entry.operation.operationId), ['family']);
  assert.equal(state.workspaceDrafts.work, undefined); assert.equal(state.workspaceDrafts.family.capture.text, 'Keep draft');
  assert.equal(state.selectedWorkspace, 'personal'); assert.equal(state.undoEdit, undefined); assert.equal(state.workspaceMove, undefined);
  assert.equal(state.workspaceErasureNotice.workspaceId, 'work');
});
