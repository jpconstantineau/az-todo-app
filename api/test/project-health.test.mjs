import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectHealth, collectionLabel } from '../../html/collections.js';

const project = { type: 'project', id: 'project', title: 'Trip', workspaceId: 'personal', status: 'active' };
const task = (status, fields = {}) => ({ type: 'item', id: crypto.randomUUID(), workspaceId: 'personal', collectionRefs: [project], status, ...fields });
const health = (status, tasks = []) => projectHealth({ ...project, status }, Object.fromEntries(tasks.map(record => [`${record.type}:${record.id}`, record])));

test('project health derives current direct tasks and keeps lifecycle separate from Next actions', () => {
  for (const status of ['active', 'draft', 'completed', 'someday']) {
    assert.deepEqual(health(status), { face: '😭', explanation: 'No tasks' });
    assert.equal(health(status, [task('next')]).face, '😐');
    for (const workflow of ['inbox', 'waiting', 'deferred', 'someday', 'on-hold', 'dropped', 'custom']) {
      assert.deepEqual(health(status, [task(workflow)]), { face: '😞', explanation: 'No next actions' });
    }
  }
  assert.deepEqual(health('completed', [task('completed')]), { face: '😊', explanation: 'Project and all tasks completed' });
  for (const status of ['active', 'draft', 'someday']) {
    assert.deepEqual(health(status, [task('completed')]), { face: '😞', explanation: 'All tasks completed; project is not completed' });
  }
  assert.equal(health('completed', [task('completed'), task('waiting')]).face, '😞');
  assert.equal(health('completed', [task('completed'), task('next')]).face, '😐');
  assert.equal(health('completed', [task('completed'), task('dropped')]).face, '😞');
});

test('project health ignores references, tombstones, other workspaces and nested-only memberships', () => {
  const ignored = [task('reference'), task('next', { deleted: true }), task('next', { workspaceId: 'other' }),
    task('next', { collectionRefs: [] }), task('next', { collectionRefs: [{ type: 'list', id: 'child' }] }),
    { type: 'list', id: 'child', parentRef: project }, { type: 'recurrenceTemplate', id: 'recurring', collectionRefs: [project], workspaceId: 'personal', status: 'next' }];
  assert.equal(health('active', ignored).face, '😭');
  assert.equal(health('active', [...ignored, task('waiting')]).face, '😞');
  const action = task('next', { projectId: 'other', collectionRefs: [{ type: 'project', id: 'other' }, project] });
  assert.equal(health('active', [...ignored, action]).face, '😐', 'secondary canonical membership counts');
  action.deleted = true; assert.equal(health('active', [action]).face, '😭');
  action.deleted = false; assert.equal(health('active', [action]).face, '😐', 'restoring recalculates');
  action.status = 'completed'; assert.equal(health('completed', [action]).face, '😊');
  action.status = 'next'; assert.equal(health('completed', [action]).face, '😐', 'reopening recalculates');
  action.collectionRefs = []; assert.equal(health('active', [action]).face, '😭', 'removing membership recalculates');
});

test('collection labels preserve lifecycle and never decorate plain collections or mutate records', () => {
  const before = structuredClone(project);
  assert.equal(collectionLabel(project, {}), 'Project: 😭 Trip — No tasks (Active)');
  assert.equal(collectionLabel(project), 'Project: Trip (Active)', 'task metadata keeps its ordinary membership label');
  assert.equal(collectionLabel({ ...project, status: 'draft' }, {}), 'Project: 😭 Trip — No tasks (Needs outcome)');
  assert.equal(collectionLabel({ type: 'list', kind: 'area', title: 'Home' }, {}), 'Area: Home');
  assert.equal(collectionLabel({ type: 'list', title: 'Errands' }, {}), 'Errands');
  assert.deepEqual(project, before);
});
