import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documents, startServer } from './harness.mjs';
import { activeMemberships, archiveOnly, archivedAncestor, collectionContents, isEffectivelyArchived, memberships, normalizeMembership, inCollection } from '../../html/collection-model.js';
import { projected, enqueue, rememberEdit, undoEdit } from '../../html/inbox-store.js';
import { deviceExport, readableExport, validateDeviceExport } from '../../html/inbox-export.js';
import { currentCreate } from './current-record.mjs';

const ref = (type, id) => ({ type, id });
const create = (type, id, fields = {}) => currentCreate(type, id, { title: id, ...(type === 'project' ? { outcome: 'Done' } : {}), ...fields });
const change = (type, id, expectedVersion, fields, action = 'update') => ({ type, id, expectedVersion, action, ...(fields ? { fields } : {}) });
async function setup(t) {
  documents.length = 0;
  const server = await startServer({ browserUser: 'alice' }); t.after(server.close);
  return async mutations => {
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, accountId: 'disposable-test-user', operationId: crypto.randomUUID(), mutations }) });
    return { status: response.status, body: await response.json() };
  };
}
test('collections: server and offline membership normalization share the same contract', async () => {
  assert.equal(await readFile(new URL('../../html/collection-model.js', import.meta.url), 'utf8'), await readFile(new URL('../api/v1/collection-model.mjs', import.meta.url), 'utf8'));
  const old = { type: 'item', id: 'task', listId: 'home', projectId: 'kitchen', collectionRefs: [ref('list', 'home'), ref('list', 'role'), ref('project', 'kitchen')] };
  const fields = { listId: 'groceries' }, expected = normalizeMembership({ ...old, ...fields }, old, fields);
  assert.deepEqual(memberships(expected), [ref('list', 'role'), ref('project', 'kitchen'), ref('list', 'groceries')]);
  const state = { records: { 'item:task': old }, queue: [{ operation: { mutations: [{ ...change('item', 'task', 1, fields) }] } }] };
  assert.deepEqual(projected(state)['item:task'].collectionRefs, expected.collectionRefs);
  assert.throws(() => normalizeMembership({}, old, { collectionRefs: [], projectId: 'kitchen' }), /Primary/);
  const records = { 'list:home': { type: 'list', id: 'home' }, 'project:kitchen': { parentRef: ref('list', 'home') } };
  assert.ok(inCollection({ type: 'item', collectionRefs: [ref('project', 'kitchen'), ref('list', 'home')] }, ref('list', 'home'), records, true));
  const destination = records['list:home'], membership = { collectionRefs: [ref('list', 'home')] };
  assert.equal(collectionContents({ type: 'recurrenceTemplate', tombstoned: false, ...membership }, destination), true);
  assert.equal(collectionContents({ type: 'recurrenceTemplate', tombstoned: true, ...membership }, destination), false);
  assert.equal(collectionContents({ type: 'item', recurrenceTemplateId: 'series', ...membership }, destination), false);
  const archived = {
    'list:home': { type: 'list', id: 'home', title: 'Home', archived: true },
    'project:kitchen': { type: 'project', id: 'kitchen', title: 'Kitchen', parentRef: ref('list', 'home') },
    'list:errands': { type: 'list', id: 'errands', title: 'Errands', archived: false }
  };
  assert.equal(archivedAncestor(ref('project', 'kitchen'), archived), archived['list:home']);
  assert.equal(isEffectivelyArchived(archived['project:kitchen'], archived), true);
  assert.equal(archiveOnly({ collectionRefs: [ref('project', 'kitchen')] }, archived), true);
  assert.equal(archiveOnly({ collectionRefs: [] }, archived), false, 'unfiled work stays active');
  assert.deepEqual(activeMemberships({ collectionRefs: [ref('project', 'kitchen'), ref('list', 'errands')] }, archived), [ref('list', 'errands')]);
});
test('collections: archive is versioned state and archived ancestry rejects only new relationships', async t => {
  const post = await setup(t);
  assert.equal((await post([
    create('list', 'home'),
    create('project', 'kitchen', { parentRef: ref('list', 'home') }),
    create('list', 'errands'),
    create('item', 'mixed', { status: 'next', collectionRefs: [ref('project', 'kitchen'), ref('list', 'errands')] }),
    create('item', 'archive-only', { status: 'waiting', waitingOn: 'Contractor', collectionRefs: [ref('project', 'kitchen')] })
  ])).status, 200);
  const archive = await post([change('list', 'home', 1, { archived: true })]);
  assert.equal(archive.status, 200);
  assert.equal(archive.body.records[0].archived, true);
  assert.equal(documents.find(document => document.id === 'record:item:archive-only').record.status, 'waiting');
  assert.deepEqual(documents.find(document => document.id === 'record:item:mixed').record.collectionRefs, [ref('project', 'kitchen'), ref('list', 'errands')]);
  assert.equal((await post([change('item', 'archive-only', 1, { title: 'Retained relationship edit' })])).status, 200);
  assert.equal((await post([create('item', 'new-link', { collectionRefs: [ref('project', 'kitchen')] })])).status, 400);
  assert.equal((await post([create('list', 'new-child', { parentRef: ref('project', 'kitchen') })])).status, 400);
  assert.equal((await post([change('list', 'home', 2, { archived: false })])).status, 200);
  assert.equal((await post([create('item', 'after-reactivation', { collectionRefs: [ref('project', 'kitchen')] })])).status, 200);
});
test('collections: multi-membership, primary edits, workspace boundaries, cycles and atomic unlink/delete', async t => {
  const post = await setup(t);
  assert.equal((await post([create('list', 'home', { kind: 'area', revisitDate: '2026-10-07' }), create('list', 'role', { kind: 'role' }), create('project', 'kitchen', { parentRef: ref('list', 'home') })])).status, 200);
  let result = await post([create('item', 'task', { listId: 'home', projectId: 'kitchen', collectionRefs: [ref('list', 'home'), ref('list', 'role'), ref('project', 'kitchen')] })]);
  assert.equal(result.status, 200);
  result = await post([change('item', 'task', 1, { listId: null, title: 'Primary edit' })]);
  assert.deepEqual(result.body.records[0].collectionRefs, [ref('list', 'role'), ref('project', 'kitchen')]);
  assert.equal((await post([change('list', 'home', 1, { parentRef: ref('project', 'kitchen') })])).status, 400);
  assert.equal((await post([change('list', 'role', 1, null, 'delete')])).status, 409);
  assert.equal((await post([change('list', 'home', 1, null, 'delete')])).status, 409);
  assert.equal((await post([create('workspace', 'work'), create('list', 'foreign', { workspaceId: 'work' })])).status, 200);
  for (const fields of [{ collectionRefs: [ref('list', 'foreign')] }, { collectionRefs: [ref('list', 'missing')] }, { collectionRefs: [ref('list', 'role'), ref('list', 'role')] }, { collectionRefs: [], listId: 'role' }]) assert.ok([400, 404].includes((await post([change('item', 'task', 2, fields)])).status));
  assert.equal((await post([change('item', 'task', 2, { workspaceId: 'work' })])).status, 400);
  assert.equal((await post([change('item', 'task', 2, { collectionRefs: [], listId: null, projectId: null, workspaceId: 'work' }), change('list', 'role', 1, null, 'delete')])).status, 200);
  assert.equal((await post([change('project', 'kitchen', 1, { parentRef: null }), change('list', 'home', 1, null, 'delete')])).status, 200);
  assert.equal((await post([create('list', 'bad-date', { revisitDate: '2026-02-30' })])).status, 400);
});
test('collections: concurrent moves cannot create a cycle; link/delete cannot orphan a task', async t => {
  const post = await setup(t);
  await post([create('list', 'a'), create('list', 'b')]);
  const moves = await Promise.all([post([change('list', 'a', 1, { parentRef: ref('list', 'b') })]), post([change('list', 'b', 1, { parentRef: ref('list', 'a') })])]);
  assert.deepEqual(moves.map(result => result.status).sort(), [200, 400]);
  await post([create('list', 'c')]);
  const race = await Promise.all([post([create('item', 'task', { collectionRefs: [ref('list', 'c')] })]), post([change('list', 'c', 1, null, 'delete')])]);
  assert.equal(race.filter(result => result.status === 200).length, 1);
});
test('collections: exports and undo preserve memberships and revisit dates', () => {
  const source = { type: 'list', id: 'packing', title: 'Packing', kind: 'reference', workspaceId: 'personal' };
  const item = { type: 'item', id: 'passport', version: 1, accountId: 'alice', deleted: false, workspaceId: 'personal', collectionRefs: [ref('list', 'packing')], title: 'Passport', description: 'Expiry', status: 'reference', listId: 'packing', areas: ['Travel'], referenceLinks: ['https://example.com/renew'] };
  const editState = { records: { 'item:passport': item, 'list:packing': { ...source, archived: false, revisitDate: '2026-10-07', version: 1, accountId: 'alice', deleted: false } }, queue: [], draft: {}, after: 0 };
  const fields = { collectionRefs: [], listId: null, projectId: null };
  enqueue(editState, 'alice', [change('item', 'passport', 1, fields)]); rememberEdit(editState, item, fields);
  undoEdit(editState, 'alice', editState.undoEdit.operationId);
  assert.deepEqual(projected(editState)['item:passport'].collectionRefs, [ref('list', 'packing')]);
  editState.records['list:packing'].archived = true;
  const exported = deviceExport('alice', editState, {});
  assert.deepEqual(validateDeviceExport(exported).warnings, []);
  assert.equal(exported.state.records['list:packing'].revisitDate, '2026-10-07');
  assert.match(readableExport(exported), /Archived: true/);
});
