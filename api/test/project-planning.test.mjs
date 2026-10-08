import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents, faults, startServer } from './harness.mjs';
import { projectPlanMutations, recoverProjectPlanDraft, acceptedPlanBriefContext } from '../../html/project-planning-model.js';
import { templateBrief } from '../../html/briefs.js';
import { deviceExport, readableExport, validateDeviceExport } from '../../html/inbox-export.js';

const create = (type, id, fields) => ({ type, id, action: 'create', expectedVersion: 0, fields: {
  ...(type === 'project' ? { workspaceId: 'personal', status: 'active' } : {}),
  ...(type === 'item' ? { workspaceId: 'personal', collectionRefs: [] } : {}), ...fields
} });
async function setup(t) {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  let sequence = 0;
  const post = async (mutations, operationId = `project-plan-${++sequence}`) => {
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json',
      'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: 'alice', userRoles: ['authenticated'] })).toString('base64') },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId, mutations }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post([create('project', 'launch', { title: 'Launch', outcome: 'Customers can use it' })])).status, 200);
  return { post };
}
const record = (type, id) => documents.find(row => row.UserID === 'alice' && row.id === `record:${type}:${id}`)?.record;
const project = () => record('project', 'launch');
const draft = project => ({ version: 1, projectId: project.id, sourceVersion: project.version, previousRevisionId: project.planningHeadId || null,
  sections: { purposePrinciples: 'Help customers finish work', desiredEvidence: 'A successful first run', organizationApproach: 'Learn, then ship', unresolvedQuestions: 'Which workflow is unclear?' },
  candidates: [
    { id: 'idea-only', title: 'Consider a launch video', kind: 'brainstorm' },
    { id: 'action', title: 'Publish the guide', kind: 'action' },
    { id: 'learn', title: 'Interview three pilot users', kind: 'learning' }
  ] });
const ids = (...values) => { let index = 0; return () => values[index++]; };

test('project planning model creates only selected canonical Next items without fabricated scheduling', () => {
  const source = { type: 'project', id: 'launch', version: 1, workspaceId: 'personal', deleted: false };
  const mutations = projectPlanMutations(source, draft(source), { 'project:launch': source }, ids('revision-1', 'item-action', 'item-learn'));
  assert.equal(mutations.length, 4);
  assert.deepEqual(mutations.map(mutation => mutation.type), ['project', 'projectPlanRevision', 'item', 'item']);
  assert.deepEqual(mutations.slice(2).map(mutation => mutation.fields.title), ['Publish the guide', 'Interview three pilot users']);
  for (const mutation of mutations.slice(2)) {
    assert.equal(mutation.fields.status, 'next');
    assert.deepEqual(mutation.fields.collectionRefs, [{ type: 'project', id: 'launch' }]);
    for (const field of ['dueDate', 'startDate', 'reviewDate', 'plannedDay', 'timeRequired']) assert.equal(field in mutation.fields, false);
  }
  assert.deepEqual(mutations[1].fields.mappings.map(mapping => mapping.kind), ['action', 'learning']);
  const tooMany = draft(source);
  tooMany.candidates = Array.from({ length: 19 }, (_, index) => ({ id: `action-${index}`, title: `Action ${index}`, kind: 'action' }));
  assert.throws(() => projectPlanMutations(source, tooMany, { 'project:launch': source }), /at most 18/i);
  const uncommitted = draft(source);
  uncommitted.candidates = uncommitted.candidates.map(candidate => ({ ...candidate, kind: 'brainstorm' }));
  assert.throws(() => projectPlanMutations(source, uncommitted, { 'project:launch': source }), /at least one Action or Bounded learning step/i);
});

test('project planning API atomically preserves immutable revisions, retries and conflicts', async t => {
  const { post } = await setup(t);
  const first = projectPlanMutations(project(), draft(project()), { 'project:launch': project() }, ids('revision-1', 'item-action', 'item-learn'));
  assert.equal((await post([first[1]])).status, 400, 'revision cannot be accepted without the head');
  const missingMapping = structuredClone(first);
  missingMapping[1].fields.mappings.pop();
  assert.equal((await post(missingMapping)).status, 400, 'every selected candidate requires an exact mapping');
  const scheduled = structuredClone(first);
  scheduled[2].fields.dueDate = '2026-10-12';
  assert.equal((await post(scheduled)).status, 400, 'plan acceptance cannot fabricate scheduling on canonical actions');
  const noNextStep = structuredClone(first);
  noNextStep[1].fields.candidates = noNextStep[1].fields.candidates.map(candidate => ({ ...candidate, kind: 'brainstorm' }));
  noNextStep[1].fields.mappings = [];
  noNextStep.splice(2);
  assert.equal((await post(noNextStep)).status, 400, 'accepted revisions require an explicit next action or bounded learning step');
  for (const [field, value] of [['plannedDay', '2026-10-12'], ['dueDateUtc', '2026-10-12T18:00:00.000Z'], ['timeRequired', '30m'], ['effortEstimate', { scale: 'tshirt', value: 'M' }]]) {
    const fabricated = structuredClone(first);
    fabricated[2].fields[field] = value;
    assert.equal((await post(fabricated)).status, 400, `plan acceptance cannot fabricate ${field}`);
  }
  assert.equal((await post([create('list', 'unrelated', { title: 'Unrelated', workspaceId: 'personal' })])).status, 200);
  const extraMembership = structuredClone(first);
  extraMembership[2].fields.collectionRefs.push({ type: 'list', id: 'unrelated' });
  assert.equal((await post(extraMembership)).status, 400, 'new accepted actions have exact project membership');
  const combinedEdit = structuredClone(first);
  combinedEdit[0].fields.title = 'Hidden concurrent title change';
  assert.equal((await post(combinedEdit)).status, 400, 'the paired project mutation advances only the planning head');
  faults.loseBatchResponse = true;
  const lost = await post(first, 'lost-plan');
  assert.equal(lost.status, 503, JSON.stringify(lost.body));
  const recovered = await post(first, 'lost-plan');
  assert.equal(recovered.status, 200);
  assert.deepEqual(await post(first, 'lost-plan'), recovered, 'same operation is idempotent after a lost acknowledgement');
  assert.equal(project().planningHeadId, 'revision-1');
  assert.equal(record('projectPlanRevision', 'revision-1').version, 1);
  assert.equal(record('item', 'item-action').status, 'next');
  assert.equal((await post([{ type: 'projectPlanRevision', id: 'revision-1', action: 'delete', expectedVersion: 1 }])).status, 400);

  const currentRecords = Object.fromEntries(documents.filter(row => row.kind === 'record').map(row => [`${row.record.type}:${row.record.id}`, row.record]));
  const secondDraft = { ...draft(project()), candidates: [
    { id: 'idea-only', title: 'Consider a launch video', kind: 'brainstorm' },
    { id: 'action', title: 'Publish the updated guide', kind: 'action', itemId: 'item-action' },
    { id: 'learn', title: 'Interview three pilot users', kind: 'brainstorm', itemId: 'item-learn' }
  ] };
  const second = projectPlanMutations(project(), secondDraft, currentRecords, ids('revision-2'));
  assert.equal(second.length, 2, 'existing selected mappings are retained without duplicating tasks');
  assert.equal((await post(second)).status, 200);
  assert.equal(record('projectPlanRevision', 'revision-1').candidates[1].title, 'Publish the guide');
  assert.equal(record('projectPlanRevision', 'revision-2').candidates[1].title, 'Publish the updated guide');
  assert.equal(record('item', 'item-learn').deleted, false, 'unselecting later does not delete earlier accepted work');

  const stale = projectPlanMutations({ ...project(), version: 2, planningHeadId: 'revision-1' }, secondDraft, currentRecords, ids('stale-revision'));
  const staleResponse = await post(stale);
  assert.equal(staleResponse.status, 409, `a concurrent accepted head produces an optimistic conflict: ${JSON.stringify(staleResponse.body)}`);

  assert.equal((await post([create('workspace', 'work', { title: 'Work' })])).status, 200);
  assert.equal((await post([
    { type: 'project', id: 'launch', action: 'update', expectedVersion: 3, fields: { workspaceId: 'work' } },
    { type: 'item', id: 'item-action', action: 'update', expectedVersion: 1, fields: { workspaceId: 'work' } },
    { type: 'item', id: 'item-learn', action: 'update', expectedVersion: 1, fields: { workspaceId: 'work' } }
  ])).status, 200, 'moving a project and its canonical actions carries accepted history without rewriting it');
  assert.equal(record('projectPlanRevision', 'revision-2').version, 1);
  assert.equal(project().planningHeadId, 'revision-2');
  assert.equal((await post([
    { type: 'project', id: 'launch', action: 'delete', expectedVersion: 4 },
    { type: 'item', id: 'item-action', action: 'delete', expectedVersion: 2 },
    { type: 'item', id: 'item-learn', action: 'delete', expectedVersion: 2 }
  ])).status, 200);
  assert.equal(record('projectPlanRevision', 'revision-2').deleted, false, 'project deletion preserves immutable planning history');
  assert.equal((await post([
    { type: 'project', id: 'launch', action: 'restore', expectedVersion: 5 },
    { type: 'item', id: 'item-action', action: 'restore', expectedVersion: 3 },
    { type: 'item', id: 'item-learn', action: 'restore', expectedVersion: 3 }
  ])).status, 200);
  assert.equal(project().planningHeadId, 'revision-2', 'restoration reconnects the preserved accepted head');
});

test('accepted plan brief context is head-only, truthful about current membership, and recoverable exactly', () => {
  const source = { type: 'project', id: 'launch', version: 2, workspaceId: 'personal', title: 'Launch', outcome: 'Customers use it', status: 'active', planningHeadId: 'revision-1', deleted: false };
  const revision = { type: 'projectPlanRevision', id: 'revision-1', version: 1, projectId: 'launch', sourceVersion: 1, previousRevisionId: null, deleted: false,
    sections: draft(source).sections, candidates: draft(source).candidates, mappings: [{ candidateId: 'action', itemId: 'item-action', kind: 'action' }, { candidateId: 'learn', itemId: 'item-learn', kind: 'learning' }] };
  const records = { 'project:launch': source, 'projectPlanRevision:revision-1': revision,
    'item:item-action': { type: 'item', id: 'item-action', version: 1, title: 'Publish the guide', workspaceId: 'personal', projectId: 'launch', collectionRefs: [{ type: 'project', id: 'launch' }], status: 'next', deleted: false },
    'item:item-learn': { type: 'item', id: 'item-learn', version: 2, title: 'Interview users', workspaceId: 'personal', projectId: null, collectionRefs: [], status: 'completed', deleted: false } };
  const context = acceptedPlanBriefContext(source, records);
  assert.match(context.context.join('\n'), /project:launch at version 2; projectPlanRevision:revision-1 at version 1/);
  assert.match(context.context.join('\n'), /Current accepted-plan action: Publish the guide/);
  assert.match(context.context.join('\n'), /item:item-learn; it is no longer a current project Next action/);
  assert.doesNotMatch(context.context.join('\n'), /launch video/);
  assert.match(context.missing.join('\n'), /Which workflow is unclear/);
  assert.match(templateBrief(source, null, records).context, /Accepted purpose & principles/);
  const pending = { ...source, localState: 'Saved on device — pending' };
  assert.deepEqual(acceptedPlanBriefContext(pending, { ...records, 'project:launch': pending }), { context: [], missing: [] });

  const pendingProject = { ...source, version: 1, planningHeadId: null, localState: undefined };
  const operation = { mutations: projectPlanMutations(pendingProject, draft(pendingProject), { 'project:launch': pendingProject }, ids('pending-revision', 'pending-action', 'pending-learn')) };
  const recovered = recoverProjectPlanDraft(operation, { ...source, version: 3, planningHeadId: 'new-head' }, records);
  assert.equal(recovered.sourceVersion, 3); assert.equal(recovered.previousRevisionId, 'new-head');
  assert.deepEqual(recovered.sections, draft(source).sections);
  assert.deepEqual(recovered.candidates.map(({ id, title, kind }) => ({ id, title, kind })), draft(source).candidates);
  const exported = deviceExport('alice', { records: Object.fromEntries(Object.entries(records).map(([key, record]) => [key, { accountId: 'alice', createdUtc: '2026-10-08T00:00:00.000Z', updatedUtc: '2026-10-08T00:00:00.000Z', ...record }])), queue: [], draft: {}, after: 1 }, {});
  assert.deepEqual(validateDeviceExport(JSON.parse(JSON.stringify(exported))).warnings, []);
  assert.match(readableExport(exported), /projectPlanRevision: revision-1/);
});
