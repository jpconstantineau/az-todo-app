import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deviceExport, readableExport, validateDeviceExport } from '../../html/inbox-export.js';

function fixture() {
  const base = { accountId: 'alice', version: 2, deleted: false, createdUtc: '2026-10-02T12:00:00.000Z' };
  const item = { ...base, type: 'item', id: 'milk', workspaceId: 'personal', collectionRefs: [{ type: 'list', id: 'groceries' }, { type: 'project', id: 'dinner' }], title: 'Milk', originalText: '  milk\n', description: 'Two cartons',
    sourceUrl: 'https://example.com/milk', selectedText: 'original selection', referenceLinks: ['https://example.com'],
    listId: 'groceries', projectId: 'dinner', plannedDay: '2026-10-03', dueDateUtc: '2026-10-04T03:00:00.000Z',
    status: 'waiting', waitingOn: 'Sam', reviewDate: '2026-10-03', startDate: '2026-10-04', areas: ['Home'],
    workflowBeforeTransition: { status: 'next', waitingOn: '', startDate: null, startDateUtc: null, reviewDate: null, reviewDateUtc: null },
    completionBeforeTransition: 'next' };
  const records = [item, { ...base, type: 'list', id: 'groceries', workspaceId: 'personal', title: 'Groceries' },
    { ...base, type: 'project', id: 'dinner', workspaceId: 'personal', status: 'active', title: 'Dinner', outcome: 'Everyone fed' },
    { ...base, type: 'settings', id: 'settings', defaults: { contexts: ['Home'] } },
    { ...item, id: 'deleted', title: 'Erased task', deleted: true, deletedUtc: base.createdUtc }];
  const mutation = { type: 'item', id: 'milk', action: 'update', expectedVersion: 1, fields: { title: 'Oat milk' } };
  const operation = { apiVersion: 1, accountId: 'alice', operationId: 'pending-id', mutations: [mutation] };
  return deviceExport('alice', { records: Object.fromEntries(records.map(record => [`${record.type}:${record.id}`, record])),
    after: 8, draft: { capture: { text: 'Saved unfinished draft' } }, queue: [{ operation, failure: 'Review competing edits',
      receipt: { apiVersion: 1, accountId: 'alice', operationId: 'pending-id', sequence: 8, status: 'conflict',
        records: [], proposed: [mutation], conflicts: [{ proposed: mutation, current: item }] } }] },
  { capture: { text: 'Unpersisted current draft', body: '', listId: '', newList: '', contexts: [] },
    edit: { type: 'item', id: 'milk', version: 2, initialFields: { title: 'Milk', description: 'Two cartons' }, fields: { title: 'Milk', description: 'Unsent edit' } } });
}

test('device exports retain current workspace drafts, editor baselines and undo without interpreting unsupported state', () => {
  const value = fixture();
  value.state.selectedWorkspace = 'work';
  value.state.workspaceDrafts = { work: { ...structuredClone(value.draft), workspaceId: 'work', editOpen: false,
    navigation: { work: { view: 'inbox', status: '' }, lists: { view: '', status: '' }, execute: { kind: 'list', view: '' } },
    review: { active: 'review-one', selected: 1, deferUntil: '' } } };
  value.state.undoEdit = { type: 'item', id: 'milk', title: 'Milk', expectedVersion: 3, operationId: 'pending-id', expiresAt: 1792000000000, fields: { description: 'Two cartons' } };
  value.state.defaultSettings = { contexts: ['Home'] };
  assert.deepEqual(validateDeviceExport(value).warnings, []);
  const text = readableExport(value);
  for (const expected of ['WORKSPACE DRAFTS', 'initialFields', 'review-one', 'LAST DEVICE EDIT RECOVERY', 'CACHED DEFAULTS']) assert.ok(text.includes(expected), expected);
  value.draft.capture.futureOption = 'Preserve for recovery';
  delete value.state.workspaceDrafts.work.edit.initialFields;
  const before = structuredClone(value);
  const warnings = validateDeviceExport(value).warnings;
  assert.ok(warnings.some(warning => warning.includes('draft.capture.futureOption')));
  assert.ok(warnings.some(warning => warning.includes('editor restore unsupported')));
  assert.deepEqual(value, before);
});

test('portable export round-trips originals, relationships, tombstones, exact queue and both drafts', async t => {
  const value = fixture(), before = structuredClone(value);
  assert.deepEqual(validateDeviceExport(value), { records: 5, pendingOperations: 1, warnings: [] });
  const directory = await mkdtemp(join(tmpdir(), 'todo-export-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.json'), output = join(directory, 'output.json');
  await writeFile(input, JSON.stringify(value));
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/validate-device-export.mjs', import.meta.url)), input, output], { encoding: 'utf8' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).liveRestore, false);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), before);
  assert.equal(run().status, 1, 'existing output must not be overwritten');
  assert.deepEqual(value, before, 'validation and text rendering never mutate snapshots');
  const text = readableExport(value);
  for (const expected of ['Milk', 'Two cartons', 'Everyone fed', '2026-10-03', 'https://example.com/milk',
    'original selection', 'pending-id', 'Oat milk', 'Unsent edit', 'Saved unfinished draft', 'Unpersisted current draft']) assert.ok(text.includes(expected), expected);
  assert.match(text, /DELETED RECORD SNAPSHOTS \(not active tasks\)[\s\S]*Erased task/);
  assert.match(text, /PENDING SAVES \(not server-confirmed\)/);
  assert.match(text, /Other devices or newer server changes may be missing/);
});

test('export rejects mixed accounts, corrupt identities, unsupported envelope versions and duplicate intents', () => {
  for (const change of [
    value => { value.state.records['item:milk'].accountId = 'bob'; },
    value => { value.state.queue[0].operation.accountId = 'bob'; },
    value => { value.state.queue[0].receipt.accountId = 'bob'; },
    value => { value.state.queue[0].receipt.conflicts[0].current.accountId = 'bob'; },
    value => { value.state.records['item:milk'].id = 'other'; },
    value => { value.formatVersion = 2; },
    value => { value.state.after = -1; },
    value => { value.state.queue.push(structuredClone(value.state.queue[0])); },
    value => { value.state.queue[0].operation.mutations[0].expectedVersion = 0; }
  ]) {
    const value = fixture(); change(value);
    assert.throws(() => validateDeviceExport(value), /Invalid device export/);
  }
});

test('export accepts only the current clarification record and mutation shape', () => {
  const current = { flowVersion: 3, step: 'classify', decision: null, proposal: { view: 'classify', mode: 'file', title: 'Milk', parentRef: null, search: '', status: 'next', waitingOn: '', reviewDate: '', startDate: '', plannedDay: '' } };
  const record = { accountId: 'alice', type: 'clarification', id: 'milk', version: 1, deleted: false, ...current };
  const value = deviceExport('alice', { records: { 'clarification:milk': record }, after: 1, queue: [], draft: {} }, {});
  assert.deepEqual(validateDeviceExport(value).warnings, []);
  const legacy = structuredClone(value); delete legacy.state.records['clarification:milk'].flowVersion;
  legacy.state.records['clarification:milk'].step = 0;
  assert.throws(() => validateDeviceExport(legacy), /current flow version and shape/);
  const pending = fixture(); pending.state.queue[0].operation.mutations[0] = { type: 'clarification', id: 'milk', action: 'create', expectedVersion: 0,
    fields: { step: 0, answers: {}, proposal: { text: '', status: '', waitingOn: '', reviewDate: '', startDate: '' } } };
  assert.throws(() => validateDeviceExport(pending), /current flow version and shape/);
  pending.state.queue[0].operation.mutations[0] = { type: 'clarification', id: 'milk', action: 'delete', expectedVersion: 1 };
  assert.throws(() => validateDeviceExport(pending), /clarification mutation must use the current shape/);
});

test('export accepts only pointer-based review history and immutable decision records', () => {
  const base = { accountId: 'alice', version: 1, deleted: false, createdUtc: '2026-10-02T12:00:00.000Z' };
  const review = { ...base, type: 'review', id: 'weekly', workspaceId: 'personal', reviewKind: 'weekly', reviewDay: '2026-10-05',
    included: [{ type: 'item', id: 'milk' }], decisionHeads: ['decision'], decisionCount: 1 };
  const decision = { ...base, type: 'reviewDecision', id: 'decision', reviewId: 'weekly', sequence: 1, index: 0,
    choice: 'retain', recordVersion: 2, before: { status: 'inbox' }, changes: {} };
  const value = deviceExport('alice', { records: { 'review:weekly': review, 'reviewDecision:decision': decision }, after: 1, queue: [], draft: {} }, {});
  assert.deepEqual(validateDeviceExport(value).warnings, []);
  const inline = structuredClone(value); inline.state.records['review:weekly'].decisions = [];
  assert.throws(() => validateDeviceExport(inline), /current history pointers/);
  const pending = fixture(); pending.state.queue[0].operation.mutations[0] = { type: 'review', id: 'weekly', action: 'create', expectedVersion: 0,
    fields: { reviewKind: 'weekly', reviewDay: '2026-10-05', included: [], decisions: [] } };
  assert.throws(() => validateDeviceExport(pending), /current history pointers/);
  pending.state.queue[0].operation.mutations[0] = { type: 'reviewDecision', id: 'decision', action: 'update', expectedVersion: 1,
    fields: { reviewId: 'weekly', sequence: 1, index: 0, choice: 'retain', recordVersion: 2, before: {}, changes: {} } };
  assert.throws(() => validateDeviceExport(pending), /create immutable history/);
});

test('unsupported fields and future record types are reported and preserved without claiming workflow support', () => {
  const value = fixture();
  value.state.records['item:milk'].futureWorkflow = { step: 2, unknowns: ['Budget'] };
  value.state.records['future:record'] = { accountId: 'alice', type: 'future', id: 'record', version: 1, deleted: false, revision: 'draft' };
  const before = JSON.stringify(value);
  const report = validateDeviceExport(value);
  assert.ok(report.warnings.some(warning => warning.includes('futureWorkflow')));
  assert.ok(report.warnings.some(warning => warning.includes('record type future')));
  assert.equal(JSON.stringify(value), before);
  assert.match(readableExport(value), /Budget/);
});
