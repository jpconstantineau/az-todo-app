import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklistResetPlan } from '../../html/checklist-reset.js';
import { enqueueChecklistReset, projected } from '../../html/inbox-store.js';

const checklist = { type: 'list', id: 'weekly', kind: 'checklist', title: 'Weekly', workspaceId: 'personal', version: 2 };
const item = (id, fields = {}) => ({ type: 'item', id, title: id, workspaceId: 'personal', version: 3,
  collectionRefs: [{ type: 'list', id: 'weekly' }], status: 'completed', ...fields });
const stateFor = items => ({ records: Object.fromEntries([checklist, { ...checklist, id: 'other' }, ...items].map(record => [`${record.type}:${record.id}`, structuredClone(record)])), queue: [], draft: {} });

test('checklist reset selects completed ordinary direct current members once, preserving metadata and other workflows', () => {
  const original = item('shared', { description: 'Notes', contexts: ['Home'], dueDate: '2026-10-16', priority: 2,
    collectionRefs: [{ type: 'list', id: 'weekly' }, { type: 'list', id: 'other' }] });
  const excluded = ['inbox', 'next', 'waiting', 'deferred', 'someday', 'reference', 'dropped', 'custom'].map(status => item(status, { status }));
  const state = stateFor([original, ...excluded, item('removed', { collectionRefs: [] }), item('nested', { collectionRefs: [{ type: 'list', id: 'child' }] }),
    item('deleted', { deleted: true }), item('other-workspace', { workspaceId: 'work' }), item('scheduled', { recurrenceTemplateId: 'schedule', occurrenceState: 'completed' })]);
  const before = structuredClone(state.records), reviewed = checklistResetPlan(state.records, checklist, 'personal');
  assert.deepEqual(reviewed.mutations, [{ type: 'item', id: 'shared', action: 'update', expectedVersion: 3, fields: { status: 'next' } }]);
  enqueueChecklistReset(state, 'alice', reviewed);
  const after = projected(state);
  assert.equal(after['item:shared'].status, 'next');
  assert.equal(after['item:shared'].nextAction, true);
  assert.equal(after['item:shared'].workflowBeforeTransition.status, 'completed');
  for (const name of ['description', 'contexts', 'dueDate', 'priority', 'collectionRefs']) assert.deepEqual(after['item:shared'][name], original[name]);
  for (const record of excluded) assert.equal(after[`item:${record.id}`].status, record.status);
  assert.deepEqual(state.records, before);
  state.records['item:added'] = item('added'); state.records['item:shared'].collectionRefs = [];
  assert.deepEqual(checklistResetPlan(state.records, checklist, 'personal').mutations.map(mutation => mutation.id), ['added']);
  for (const changed of [{ archived: true }, { deleted: true }, { kind: 'list' }, { workspaceId: 'work' }]) {
    const records = { ...before, 'list:weekly': { ...checklist, ...changed } };
    assert.equal(checklistResetPlan(records, checklist, 'personal'), null);
  }
  const work = { ...checklist, workspaceId: 'work' };
  for (const workspace of [undefined, { archived: true }, { deleted: true }]) {
    const readOnly = { queue: [], draft: {}, records: {
      'list:weekly': work, 'item:read-only': item('read-only', { workspaceId: 'work' }), ...(workspace ? { 'workspace:work': workspace } : {})
    } };
    const plan = checklistResetPlan(readOnly.records, work, 'work');
    assert.equal(plan.mutations.length, 1, 'selection remains available for a disabled read-only control');
    assert.throws(() => enqueueChecklistReset(readOnly, 'alice', plan), /active workspace/); assert.equal(readOnly.queue.length, 0);
  }
  assert.equal(checklistResetPlan({ ...before, 'list:weekly': { ...checklist, parentRef: { type: 'list', id: 'parent' } }, 'list:parent': { archived: true } }, checklist, 'personal'), null);
});

test('checklist reset validates the complete review and queue capacity before adding any chunks', () => {
  const state = stateFor(Array.from({ length: 41 }, (_, i) => item(`item-${i}`)));
  const reviewed = checklistResetPlan(state.records, checklist, 'personal');
  enqueueChecklistReset(state, 'alice', reviewed);
  assert.deepEqual(state.queue.map(entry => entry.operation.mutations.length), [20, 20, 1]);
  assert.equal(new Set(state.queue.map(entry => entry.operation.operationId)).size, 3);
  assert.ok(state.queue.every(entry => entry.checklistReset.id === 'weekly' && entry.operation.accountId === 'alice'));
  assert.equal(Object.values(projected(state)).filter(record => record.status === 'next').length, 41);
  for (const edit of [records => { records['item:item-0'].version++; }, records => { records['item:item-0'].collectionRefs = []; },
    records => { records['item:new'] = item('new'); }, records => { records['list:weekly'].version++; }]) {
    const stale = stateFor([item('item-0')]), review = checklistResetPlan(stale.records, checklist, 'personal');
    edit(stale.records); assert.throws(() => enqueueChecklistReset(stale, 'alice', review), /changed/); assert.equal(stale.queue.length, 0);
  }
  const full = stateFor(Array.from({ length: 21 }, (_, i) => item(`item-${i}`)));
  full.queue = Array.from({ length: 1023 }, (_, i) => ({ operation: { operationId: `pending-${i}`, mutations: [] } }));
  assert.throws(() => enqueueChecklistReset(full, 'alice', checklistResetPlan(full.records, checklist, 'personal')), /queue is full/);
  assert.equal(full.queue.length, 1023, 'no first chunk was added');
});
