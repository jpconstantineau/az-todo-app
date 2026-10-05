import { clickControl, openMenu } from './navigation-helper.mjs';
import { test } from 'node:test';
import { waitForBrowser } from './browser-wait.mjs';
import { showView } from './navigation-helper.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { validateDeviceExport, validateAccountExport } from '../../html/inbox-export.js';

async function download(page, format = 'json') {
  await openMenu(page);
  await clickControl(page.locator('#exportFormat'));
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
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=2')).transact('alice')).draft.capture.text === 'Alice unfinished draft');
  await page.reload(); await page.locator('#workspace').waitFor();
  await showView(page, 'work');
  await page.locator('#statusFilter').selectOption('completed');
  assert.equal(await page.locator('#items article').count(), 0);
  // A completed write from another tab need not have broadcast before exporting.
  await page.evaluate(async () => {
    const { transact, enqueue } = await import('/inbox-store.js?v=2');
    await transact('alice', state => enqueue(state, 'alice', [{ type: 'item', id: 'other-tab', action: 'create', expectedVersion: 0,
      fields: { title: 'Other tab pending task', originalText: 'Other tab source', workspaceId: 'personal', collectionRefs: [], status: 'inbox' } }]));
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
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=2')).transact(null)).accountId === 'bob');
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

test('server download includes unsynced remote records, excludes local drafts, and supports both formats without changing device data', { timeout: 60000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await page.route('**/api/v1/changes?*', route => route.abort());
  const saved = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: 'other-device', mutations: [
      { type: 'item', id: 'remote', expectedVersion: 0, action: 'create', fields: { title: 'Only on the server <script>', originalText: 'Exact remote original', workspaceId: 'personal', collectionRefs: [] } }
    ] }) });
  assert.equal(saved.status, 200);
  await page.locator('#captureText').fill('Unsubmitted local draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=2')).transact('alice')).draft.capture.text === 'Unsubmitted local draft');
  const local = () => page.evaluate(async () => (await import('/inbox-store.js?v=2')).transact('alice'));
  const before = await local(), serverBefore = structuredClone(documents);
  assert.deepEqual(before.records, {});
  await openMenu(page);
  for (const format of ['json', 'text']) {
    await clickControl(page.locator('#exportFormat'));
    await page.locator('#exportFormat').selectOption(format);
    const pending = page.waitForEvent('download');
    await page.locator('#accountExport').click();
    const file = await pending, text = await readFile(await file.path(), 'utf8');
    assert.equal(file.suggestedFilename(), format === 'json' ? 'todo-account.json' : 'todo-account.txt');
    assert.match(text, /Only on the server <script>/); assert.doesNotMatch(text, /Unsubmitted local draft/);
    if (format === 'json') assert.equal(validateAccountExport(JSON.parse(text)).records, 1);
  }
  assert.deepEqual(await local(), before); assert.deepEqual(documents, serverBefore);
  assert.equal(await page.locator('#captureText').inputValue(), 'Unsubmitted local draft');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await openMenu(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.EXPORT_SCREENSHOTS) {
      await mkdir(process.env.EXPORT_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.EXPORT_SCREENSHOTS}/server-export-${width}.png`, fullPage: true });
    }
  }
  await context.setOffline(true);
  await page.locator('#accountExport').click();
  await page.waitForFunction(() => document.querySelector('#exportStatus').textContent.includes('Export failed'));
  assert.equal(JSON.parse(await download(page)).draft.capture.text, 'Unsubmitted local draft');
});

test('server export cancels promptly, rejects malformed/error pages and discards delayed results on account switch', { timeout: 60000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  const downloads = []; page.on('download', file => downloads.push(file));
  const pattern = '**/api/v1/export?*';
  let held;
  await page.route(pattern, route => { held = route; });
  await clickControl(page.locator('#accountExport'));
  await page.locator('#cancelExport').click();
  await page.waitForFunction(() => document.querySelector('#exportStatus').textContent.includes('cancelled'));
  assert.equal(await page.locator('#accountExport').evaluate(el => el === document.activeElement), true);
  await held.abort(); await page.unroute(pattern);
  for (const status of [200, 503]) {
    await page.route(pattern, route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ apiVersion: 1, message: 'Try again' }) }));
    await page.locator('#accountExport').click();
    await page.waitForFunction(() => document.querySelector('#exportStatus').textContent.includes('Export failed'));
    await page.locator('#appMenu > summary').click();
    assert.equal(await page.locator('#error').isVisible(), true, 'export failures remain visible with Menu closed');
    await page.locator('#appMenu > summary').click();
    await page.unroute(pattern);
  }
  let release;
  const intercepted = new Promise(resolve => { release = resolve; });
  await page.route(pattern, async route => {
    const response = await route.fetch();
    held = { route, response }; release();
  });
  await page.locator('#accountExport').click(); await intercepted;
  user = 'bob';
  const bobChanges = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/changes' && response.ok());
  await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=2')).transact(null)).accountId === 'bob');
  await held.route.fulfill({ response: held.response });
  await page.unroute(pattern);
  await page.waitForFunction(() => !document.querySelector('#accountExport').disabled);
  assert.equal(downloads.length, 0);
  // The stored account changes before its controls return and sync requests finish.
  // Let Bob's change request finish before simulating a separate sign-out.
  await bobChanges;
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.' && !document.querySelector('#menuDeviceTools').hidden);
  user = null;
  await clickControl(page.locator('#accountExport'));
  await page.waitForFunction(() => document.querySelector('#workspace').hidden);
  assert.equal(downloads.length, 0);
});
