import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents, faults, startServer } from './harness.mjs';
import { materializeMutations, resolveOccurrenceMutations, zonedDate } from '../../html/recurrence-model.js';
import { accountExport } from '../../html/inbox-export.js';

async function fixture(t) {
  documents.length = 0; Object.assign(faults, { nextWrite: false, batchIndex: -1, loseBatchResponse: false });
  const server = await startServer(); t.after(server.close);
  const post = async operation => {
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json',
      'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: 'alice', userRoles: ['authenticated'] })).toString('base64') }, body: JSON.stringify(operation) });
    return { status: response.status, body: await response.json() };
  };
  const get = async path => {
    const response = await fetch(server.url + '/api/v1/' + path, { headers: { origin: server.url,
      'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: 'alice', userRoles: ['authenticated'] })).toString('base64') } });
    assert.equal(response.status, 200); return response.json();
  };
  return { post, get };
}

const templateFields = anchorDate => ({ title: 'Water plants', description: 'Kitchen first', workspaceId: 'personal', collectionRefs: [], listId: null, projectId: null, status: 'inbox', contexts: ['Home'], areas: [], energy: 'Low', timeRequired: '5m', priority: null, referenceLinks: [],
  rule: { mode: 'fixed', unit: 'day', interval: 1, anchorDate, timeZone: 'America/Regina' }, paused: false, tombstoned: false, nextOccurrenceNumber: 1, nextIntendedDate: anchorDate, openOccurrenceId: null, lastResolvedUtc: null });
const operation = (operationId, mutations) => ({ apiVersion: 1, accountId: 'alice', operationId, mutations });

test('recurrence transitions are repeat-safe, cross-device deterministic and terminal history is immutable', async t => {
  const f = await fixture(t), today = zonedDate(new Date(), 'America/Regina');
  const created = await f.post(operation('create-template', [{ type: 'recurrenceTemplate', id: 'plants', action: 'create', expectedVersion: 0, fields: templateFields(today) }]));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const template = created.body.records[0], first = materializeMutations(template), second = structuredClone(first);
  const [a, b] = await Promise.all([f.post(operation('materialize-a', first)), f.post(operation('materialize-b', second))]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(a.body.records.find(record => record.type === 'item').id, b.body.records.find(record => record.type === 'item').id);
  assert.deepEqual(await f.post(operation('materialize-a', first)), a, 'same operation ID returns the same receipt');
  const unrelatedConflict = await f.post(operation('not-materialization', [
    { type: 'recurrenceTemplate', id: 'plants', action: 'update', expectedVersion: template.version, fields: { title: template.title } },
    first[1]
  ]));
  assert.equal(unrelatedConflict.status, 409, 'only the exact linked materialization shape may be treated as already satisfied');
  const exported = await accountExport('alice', f.get);
  assert.equal(Object.values(exported.state.records).filter(record => record.type === 'item' && record.recurrenceTemplateId === 'plants').length, 1,
    'the equivalent cross-device receipt must remain replayable in account export history');
  const currentTemplate = [a, b].flatMap(result => result.body.records).filter(record => record.type === 'recurrenceTemplate').sort((x, y) => y.version - x.version)[0];
  const item = [a, b].flatMap(result => result.body.records).find(record => record.type === 'item');
  const cursorOnly = await f.post(operation('cursor-forgery', [{ type: 'recurrenceTemplate', id: 'plants', action: 'update', expectedVersion: currentTemplate.version, fields: { openOccurrenceId: null } }]));
  assert.equal(cursorOnly.status, 400);
  const completed = await f.post(operation('complete-occurrence', resolveOccurrenceMutations(item, currentTemplate, 'completed', new Date().toISOString())));
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.deepEqual(await f.post(operation('materialize-b', second)), b, 'accepted competing materialization remains retry-safe after resolution');
  const terminal = completed.body.records.find(record => record.type === 'item');
  assert.equal(terminal.occurrenceState, 'completed'); assert.equal(terminal.status, 'completed');
  const rewrite = await f.post(operation('rewrite-history', [{ type: 'item', id: terminal.id, action: 'update', expectedVersion: terminal.version, fields: { title: 'Changed history' } }]));
  assert.equal(rewrite.status, 400);
  const workspace = await f.post(operation('create-workspace', [{ type: 'workspace', id: 'work', action: 'create', expectedVersion: 0, fields: { title: 'Work' } }]));
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  const resolvedTemplate = completed.body.records.find(record => record.type === 'recurrenceTemplate');
  const moved = await f.post(operation('move-history', [
    { type: 'recurrenceTemplate', id: resolvedTemplate.id, action: 'update', expectedVersion: resolvedTemplate.version, fields: { workspaceId: 'work' } },
    { type: 'item', id: terminal.id, action: 'update', expectedVersion: terminal.version, fields: { workspaceId: 'work' } }
  ]));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.ok(moved.body.records.every(record => record.workspaceId === 'work'), 'template and terminal history move together without rewriting the snapshot');
});

test('recurrence trust boundary rejects orphan, forged and unpaired occurrence transitions', async t => {
  const f = await fixture(t), today = zonedDate(new Date(), 'America/Regina'), base = templateFields(today);
  const orphan = { ...base, recurrenceTemplateId: 'missing', recurrenceNumber: 1, intendedDate: today, sourceTemplateVersion: 1, occurrenceState: 'open', occurrenceResolvedUtc: null };
  assert.equal((await f.post(operation('orphan', [{ type: 'item', id: 'rec-5a013c95ce41024e-1', action: 'create', expectedVersion: 0, fields: orphan }]))).status, 400);
  assert.equal((await f.post(operation('bad-zone', [{ type: 'recurrenceTemplate', id: 'bad', action: 'create', expectedVersion: 0, fields: { ...base, rule: { ...base.rule, timeZone: 'Invalid/Zone' } } }]))).status, 400);
  const created = await f.post(operation('create-valid', [{ type: 'recurrenceTemplate', id: 'valid', action: 'create', expectedVersion: 0, fields: base }]));
  const template = created.body.records[0], mutations = materializeMutations(template);
  assert.equal((await f.post(operation('unpaired-item', [mutations[1]]))).status, 400);
  assert.equal((await f.post(operation('unpaired-pointer', [mutations[0]]))).status, 400);
});

test('skip maps to dropped history and competing terminal transitions accept only one winner', async t => {
  const f = await fixture(t), today = zonedDate(new Date(), 'America/Regina');
  async function open(id) {
    const created = await f.post(operation(`create-${id}`, [{ type: 'recurrenceTemplate', id, action: 'create', expectedVersion: 0, fields: templateFields(today) }]));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const materialized = await f.post(operation(`materialize-${id}`, materializeMutations(created.body.records[0])));
    assert.equal(materialized.status, 200, JSON.stringify(materialized.body));
    return { template: materialized.body.records.find(record => record.type === 'recurrenceTemplate'), item: materialized.body.records.find(record => record.type === 'item') };
  }
  const skipped = await open('skip-series'), resolved = '2026-10-07T18:00:00.000Z';
  const skip = await f.post(operation('skip-once', resolveOccurrenceMutations(skipped.item, skipped.template, 'skipped', resolved)));
  assert.equal(skip.status, 200, JSON.stringify(skip.body));
  assert.deepEqual(Object.fromEntries(['occurrenceState', 'status', 'occurrenceResolvedUtc'].map(name => [name, skip.body.records.find(record => record.type === 'item')[name]])),
    { occurrenceState: 'skipped', status: 'dropped', occurrenceResolvedUtc: resolved });

  const competing = await open('competing-series');
  const [complete, skipCompeting] = await Promise.all([
    f.post(operation('competing-complete', resolveOccurrenceMutations(competing.item, competing.template, 'completed', resolved))),
    f.post(operation('competing-skip', resolveOccurrenceMutations(competing.item, competing.template, 'skipped', resolved)))
  ]);
  assert.deepEqual([complete.status, skipCompeting.status].sort(), [200, 409]);
  const winner = [complete, skipCompeting].find(result => result.status === 200).body.records.find(record => record.type === 'item');
  assert.equal(winner.status, winner.occurrenceState === 'completed' ? 'completed' : 'dropped');

  const stopped = await open('stopped-series');
  const stop = await f.post(operation('stop-series', [{ type: 'recurrenceTemplate', id: stopped.template.id, action: 'update', expectedVersion: stopped.template.version, fields: { paused: true, tombstoned: true } }]));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const stoppedTemplate = stop.body.records[0];
  assert.equal((await f.post(operation('rewrite-stopped', [{ type: 'recurrenceTemplate', id: stoppedTemplate.id, action: 'update', expectedVersion: stoppedTemplate.version, fields: { title: 'Rewritten stop' } }]))).status, 400);
  const resolvedStopped = await f.post(operation('resolve-stopped', resolveOccurrenceMutations(stopped.item, stoppedTemplate, 'completed', resolved)));
  assert.equal(resolvedStopped.status, 200, JSON.stringify(resolvedStopped.body));
  assert.equal(resolvedStopped.body.records.find(record => record.type === 'recurrenceTemplate').nextIntendedDate, stoppedTemplate.nextIntendedDate);
});
