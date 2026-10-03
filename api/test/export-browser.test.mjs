import { clickControl, openMenu } from './navigation-helper.mjs';
import { test } from 'node:test';
import { waitForBrowser } from './browser-wait.mjs';
import { showView } from './navigation-helper.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { validateDeviceExport } from '../../html/inbox-export.js';

async function download(page, format = 'json') {
  await openMenu(page);
  await page.locator('#exportFormat').selectOption(format);
  const pending = page.waitForEvent('download');
  await clickControl(page.locator('#export'));
  const file = await pending;
  assert.equal(file.suggestedFilename(), format === 'json' ? 'todo-device-recovery.json' : 'todo-tasks.txt');
  return readFile(await file.path(), 'utf8');
}

test('export works offline after reload, includes unfiltered work, fresh IDB state and drafts, and isolates accounts', { timeout: 90000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 740 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.locator('#captureText').fill('Confirmed Alice task');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '' && document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.locator('#captureText').fill('Pending Alice task');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await page.locator('#captureText').fill('Alice unfinished draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Alice unfinished draft');
  await page.reload(); await page.locator('#workspace').waitFor();
  await showView(page, 'work');
  await page.locator('#statusFilter').selectOption('completed');
  assert.equal(await page.locator('#items article').count(), 0);
  // A completed write from another tab need not have broadcast before exporting.
  await page.evaluate(async () => {
    const { transact, enqueue } = await import('/inbox-store.js');
    await transact('alice', state => enqueue(state, 'alice', [{ type: 'item', id: 'other-tab', action: 'create', expectedVersion: 0,
      fields: { title: 'Other tab pending task', originalText: 'Other tab source' } }]));
  });
  const before = JSON.stringify(documents), value = JSON.parse(await download(page));
  assert.equal(value.accountId, 'alice'); assert.equal(value.source, 'indexeddb');
  assert.equal(validateDeviceExport(value).pendingOperations, 2);
  assert.equal(value.draft.capture.text, 'Alice unfinished draft');
  assert.equal(Object.values(value.state.records)[0].title, 'Confirmed Alice task');
  const text = await download(page, 'text');
  for (const expected of ['Confirmed Alice task', 'Pending Alice task', 'Other tab pending task', 'Alice unfinished draft']) assert.ok(text.includes(expected));
  assert.equal(JSON.stringify(documents), before, 'export does not submit or mutate records');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  for (const view of ['capture', 'work', 'lists']) {
    await showView(page, view);
    const exported = JSON.parse(await download(page));
    assert.equal(exported.draft.capture.text, 'Alice unfinished draft');
    assert.equal(validateDeviceExport(exported).pendingOperations, 2);
    assert.equal(Object.values(exported.state.records)[0].title, 'Confirmed Alice task');
  }

  // Hold completion of just the export's storage read while the session changes.
  const downloads = []; page.on('download', file => downloads.push(file));
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    IDBDatabase.prototype.transaction = function (...args) {
      const result = transaction.apply(this, args);
      if (args[1] === 'readonly') {
        IDBDatabase.prototype.transaction = transaction;
        Object.defineProperty(result, 'oncomplete', { set(callback) {
          complete.set.call(result, event => { window.releaseExport = () => callback(event); });
        } });
      }
      return result;
    };
    window.pendingExport = document.querySelector('#export').onclick();
  });
  await page.waitForFunction(() => !!window.releaseExport);
  user = 'bob'; await context.setOffline(false);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now', exact: true }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).accountId === 'bob');
  await page.locator('#workspace').waitFor();
  await page.evaluate(async () => { window.releaseExport(); await window.pendingExport; });
  assert.equal(downloads.length, 0, 'a delayed Alice export cannot download in Bob’s session');
  const bob = await download(page);
  assert.equal(JSON.parse(bob).accountId, 'bob'); assert.doesNotMatch(bob, /Alice|Other tab/);
  assert.deepEqual(errors, []);
});

test('export retains current form text when local storage reads fail', { timeout: 60000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.evaluate(() => { IDBDatabase.prototype.transaction = () => { throw new Error('Injected storage failure'); }; });
  await page.locator('#captureText').fill('Text that could not be journaled');
  await page.locator('#recovery').waitFor();
  const value = JSON.parse(await download(page));
  assert.equal(value.source, 'memory-recovery');
  assert.equal(value.draft.capture.text, 'Text that could not be journaled');
});
