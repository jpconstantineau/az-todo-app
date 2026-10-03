import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl, showView, openMenu } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { key, projected, enqueue, applyReceipt, rememberEdit, canUndoEdit, undoEdit } from '../../html/inbox-store.js';
import { deviceExport, validateDeviceExport, readableExport } from '../../html/inbox-export.js';

const now = Date.now();
const week = 7 * 24 * 60 * 60 * 1000;
function fixture(type = 'item') {
  const record = { type, id: 'one', accountId: 'alice', version: 1, deleted: false, title: 'Original',
    description: 'Keep notes', originalText: '  Original\n', sourceUrl: 'https://example.com',
    status: 'inbox', outcome: 'Original outcome', contexts: ['Home'], priority: null };
  const state = { records: { [key(record)]: record }, queue: [], draft: {}, after: 0 };
  const fields = { title: 'Edited', description: 'New notes', ...(type === 'project' ? { outcome: 'New outcome' } :
    type === 'item' ? { dueDate: '2026-11-01', contexts: ['Work'], priority: 'high' } : {}) };
  enqueue(state, 'alice', [{ type, id: record.id, action: 'update', expectedVersion: 1, fields }]);
  rememberEdit(state, record, fields, now);
  return state;
}
const receipt = (state, record, operationId = state.undoEdit.operationId) => ({ apiVersion: 1, accountId: 'alice',
  operationId, sequence: 1, status: 'committed', records: [record] });

test('edit undo restores changed fields for items, lists and projects after reload and acknowledgement', () => {
  for (const type of ['item', 'list', 'project']) for (const acknowledged of [false, true]) {
    const state = JSON.parse(JSON.stringify(fixture(type))), original = structuredClone(state.records[`${type}:one`]);
    const edited = projected(state)[`${type}:one`];
    if (acknowledged) applyReceipt(state, receipt(state, edited), 'alice');
    assert.equal(canUndoEdit(state, now), true);
    const snapshot = structuredClone(state.undoEdit);
    undoEdit(state, 'alice', snapshot.operationId, now);
    const restored = projected(state)[`${type}:one`];
    for (const name of ['title', 'description', 'originalText', 'sourceUrl', 'outcome', 'contexts', 'priority']) assert.deepEqual(restored[name], original[name]);
    if (type === 'item') assert.equal(restored.dueDate, null, 'unset calendar date is cleared');
    assert.equal(restored.version, 3);
    assert.equal(state.queue.at(-1).operation.mutations[0].expectedVersion, 2);
    assert.notEqual(state.queue.at(-1).operation.operationId, snapshot.operationId);
    assert.equal(canUndoEdit(state, now), false, 'one step, no redo');
    assert.throws(() => undoEdit(state, 'alice', snapshot.operationId, now));
  }
});

test('undo expires at seven days and rejects failed, replaced, changed and deleted records without queuing', () => {
  for (const change of [
    state => { state.queue[0].failure = 'Rejected'; },
    state => { state.records['item:one'] = { ...state.records['item:one'], version: 3 }; },
    state => { state.records['item:one'].deleted = true; },
    state => enqueue(state, 'alice', [{ type: 'item', id: 'one', action: 'update', expectedVersion: 2, fields: { title: 'Later' } }]),
    state => enqueue(state, 'alice', [{ type: 'item', id: 'one', action: 'delete', expectedVersion: 2 }])
  ]) {
    const state = fixture(), id = state.undoEdit.operationId; change(state);
    const before = structuredClone(state);
    assert.equal(canUndoEdit(state, now), false);
    assert.throws(() => undoEdit(state, 'alice', id, now));
    assert.deepEqual(state, before);
  }
  const state = fixture(), id = state.undoEdit.operationId;
  assert.equal(canUndoEdit(state, now + week - 1), true);
  assert.equal(canUndoEdit(state, now + week), false);
  assert.throws(() => undoEdit(state, 'alice', id, now + week));
  assert.throws(() => undoEdit(state, 'alice', 'older-editor-save', now));
  const other = { type: 'list', id: 'other', version: 1, title: 'Other' };
  state.records[key(other)] = other;
  enqueue(state, 'alice', [{ type: 'list', id: 'other', action: 'update', expectedVersion: 1, fields: { title: 'Updated' } }]);
  rememberEdit(state, other, { title: 'Updated' }, now);
  assert.throws(() => undoEdit(state, 'alice', id, now), 'another editor save replaces the slot');
});

test('competing same-version receipts and rejected edit receipts invalidate undo', () => {
  const state = fixture(), id = state.undoEdit.operationId;
  applyReceipt(state, receipt(state, { ...state.records['item:one'], version: 2, title: 'Remote' }, 'remote-edit'), 'alice');
  assert.equal(state.undoEdit, undefined, 'cannot undo a competing version after discarding the local edit');
  const failed = fixture();
  applyReceipt(failed, { ...receipt(failed, null), status: 'conflict', records: [],
    conflicts: [{ current: failed.records['item:one'] }] }, 'alice');
  assert.equal(failed.undoEdit, undefined);
  assert.throws(() => undoEdit(state, 'alice', id, now));
  // A later offline edit's inverse must not recover a rejected predecessor.
  const chained = fixture(), previous = structuredClone(chained.queue[0].operation);
  const current = projected(chained)['item:one'];
  enqueue(chained, 'alice', [{ type: 'item', id: 'one', action: 'update', expectedVersion: 2, fields: { title: 'Second edit' } }]);
  rememberEdit(chained, current, { title: 'Second edit' }, now);
  applyReceipt(chained, { apiVersion: 1, accountId: 'alice', operationId: previous.operationId, sequence: 2,
    status: 'conflict', records: [], conflicts: [{ current: chained.records['item:one'] }] }, 'alice');
  assert.equal(chained.undoEdit, undefined);
});

test('device export preserves exact undo fields and explains them in readable output', () => {
  const state = fixture(), exported = deviceExport('alice', state, state.draft);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)).state.undoEdit, state.undoEdit);
  assert.deepEqual(validateDeviceExport(exported).warnings, []);
  assert.match(readableExport(exported), /LAST DEVICE EDIT RECOVERY/);
  assert.match(readableExport(exported), /Keep notes/);
});

const local = page => page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
async function confirmed(page) {
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).queue.length === 0 &&
    document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
}
async function setup(t) {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await page.locator('#captureText').fill('Original');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#captureText').value); await confirmed(page);
  return { page, context, server, setUser: value => { user = value; } };
}
async function edit(page, title = 'Edited') {
  await showView(page, 'work');
  await page.getByRole('button', { name: 'Edit Original', exact: true }).click();
  await page.locator('#edit [name=title]').fill(title);
  await page.locator('#edit [name=description]').fill('Edited notes');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
}

async function clickUndo(page) {
  await openMenu(page);
  await clickControl(page.locator('#undoEdit'));
}

test('browser undo survives offline edit/reload, preserves drafts, and syncs once', { timeout: 60000 }, async t => {
  const { page, context } = await setup(t);
  await context.setOffline(true); await edit(page);
  await showView(page, 'capture'); await page.locator('#captureText').fill('Keep this draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Keep this draft');
  const before = await local(page);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#undoEdit').isDisabled(), false);
  assert.deepEqual((await local(page)).undoEdit, before.undoEdit);
  await clickUndo(page);
  await waitForBrowser(page, async () => !(await (await import('/inbox-store.js')).transact('alice')).undoEdit);
  assert.equal(await page.locator('#captureText').inputValue(), 'Keep this draft');
  assert.equal((await local(page)).queue.length, 2);
  await showView(page, 'work'); await page.getByRole('button', { name: 'Edit Original', exact: true }).waitFor();
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  const record = documents.find(doc => doc.id.startsWith('record:item:')).record;
  assert.equal(record.title, 'Original'); assert.equal(record.description, ''); assert.equal(record.originalText, 'Original');
  assert.equal(record.version, 3); assert.equal(await page.locator('#undoEdit').isDisabled(), true);
  assert.equal(documents.filter(doc => doc.kind === 'receipt').length, 3);
});

test('browser undo stays account-bound, survives server confirmation and rechecks expiry at click time', { timeout: 60000 }, async t => {
  const { page, setUser } = await setup(t);
  await edit(page); await confirmed(page);
  const recovery = (await local(page)).undoEdit;
  assert.ok(recovery);
  setUser('bob'); await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).accountId === 'bob');
  assert.equal(await page.locator('#undoEdit').isDisabled(), true);
  assert.doesNotMatch(await page.locator('#undoEditStatus').textContent(), /Original/);
  setUser('alice'); await clickControl(page.locator('#sync')); await confirmed(page);
  await page.reload(); await page.locator('#workspace').waitFor(); await confirmed(page);
  assert.equal(await page.locator('#undoEdit').isDisabled(), false);
  if (process.env.UNDO_SCREENSHOTS) {
    await mkdir(process.env.UNDO_SCREENSHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await openMenu(page);
      const recovery = page.locator('#undoEdit').locator('xpath=ancestor::details[1]');
      if (!await recovery.evaluate(element => element.open)) await recovery.locator(':scope > summary').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${process.env.UNDO_SCREENSHOTS}/edit-undo-${theme}-${width}.png`, fullPage: true });
    }
  }
  await page.evaluate(async () => (await import('/inbox-store.js')).transact('alice', state => { state.undoEdit.expiresAt = Date.now() - 1; }));
  await clickUndo(page);
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('can no longer be undone'));
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(documents.find(doc => doc.id.startsWith('record:item:')).record.title, 'Edited');
});

test('undo rejected after a remote edit or deletion keeps the server record intact', { timeout: 60000 }, async t => {
  const { page, context, server } = await setup(t);
  await edit(page); await confirmed(page); await context.setOffline(true);
  const record = documents.find(doc => doc.id.startsWith('record:item:')).record;
  const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: 'remote-delete',
      mutations: [{ type: 'item', id: record.id, action: 'delete', expectedVersion: record.version }] }) });
  assert.equal(response.status, 200);
  await clickUndo(page);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).queue.length === 1);
  await context.setOffline(false); await clickControl(page.locator('#sync')); await page.locator('#failure').waitFor();
  assert.equal(documents.find(doc => doc.id.startsWith('record:item:')).record.deleted, true);
  assert.equal((await local(page)).queue[0].receipt.status, 'conflict');
  assert.equal(await page.locator('#items article').count(), 0);
  assert.equal(await page.locator('#undoEdit').isDisabled(), true);
});
