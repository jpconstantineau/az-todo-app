import { clickControl, openMenu } from './navigation-helper.mjs';
import { showView } from './navigation-helper.mjs';
import { test } from 'node:test';
import { waitForBrowser } from './browser-wait.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';

const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;
const records = () => documents.filter(doc => doc.kind === 'record').map(doc => doc.record);
async function setup(t, options = {}) {
  documents.length = 0;
  Object.assign(faults, { nextWrite: false, batchIndex: -1, loseBatchResponse: false });
  let user = 'alice';
  const server = await startServer({ browserUser: () => user });
  t.after(server.close);
  const browser = await chromium.launch({ channel });
  t.after(() => browser.close());
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', failure => errors.push(failure.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${server.url}/inbox.html`);
  await page.locator('#workspace').waitFor();
  await confirmed(page);
  // Offline checks import uncached module URLs too; wait for shell activation/cache completion.
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  return { ...server, browser, context, page, setUser(value) { user = value; } };
}
async function confirmed(page) {
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
}
async function local(page) {
  return page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
}
async function capture(page, text, newList) {
  await showView(page, 'capture'); await page.locator('#captureText').fill(text);
  if (newList) {
    if (!await page.locator('#captureOptions').getAttribute('open')) await page.locator('#captureOptions > summary').click();
    await page.locator('[name=newList]').fill(newList);
  }
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
}
async function serverEdit(url, record, fields, action = 'update') {
  const response = await fetch(`${url}/api/v1/operations`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(),
      mutations: [{ type: record.type, id: record.id, action, expectedVersion: record.version, ...(fields ? { fields } : {}) }] }) });
  assert.equal(response.status, 200);
}

test('inbox: groceries capture, offline editing/moving/completion, original input and mobile keyboard layout', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t, { viewport: { width: 390, height: 844 } });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await capture(page, '  milk\r\n\n bread\neggs  ', 'Groceries');
  assert.equal(await page.locator('#items article').count(), 3);
  await openMenu(page);
  await page.locator('#connection > summary').click();
  assert.match(await page.locator('#syncStatus').innerText(), /1 save.*pending/);
  const queued = await local(page);
  assert.equal(queued.queue[0].operation.mutations.length, 4);
  assert.equal(queued.queue[0].operation.mutations[1].fields.originalText, '  milk\n\n bread\neggs  ');
  assert.equal(records().length, 0);
  await page.reload();
  await showView(page, 'work'); await page.locator('#items article').first().waitFor();
  await showView(page, 'work'); await page.getByRole('button', { name: 'Edit milk', exact: true }).click();
  await page.locator('#edit [name=title]').fill('Oat milk');
  await page.locator('#edit [name=description]').fill('Unsweetened\nTwo cartons');
  await page.locator('#edit [name=listId]').selectOption('');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await showView(page, 'work'); await page.locator('#view').selectOption('all'); await page.locator('#statusFilter').selectOption('@all');
  await showView(page, 'work'); await page.getByRole('button', { name: 'Complete Oat milk' }).click();
  await showView(page, 'work'); await page.getByRole('button', { name: 'Reopen Oat milk' }).click();
  await showView(page, 'lists'); await page.locator('#view').selectOption({ label: "Groceries" }); await page.getByRole('button', { name: 'Edit list: Groceries' }).click();
  await page.locator('#edit [name=title]').fill('Weekend groceries');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  // A click only starts the save. The editor closes after the IDB transaction commits.
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.reload(); await showView(page, 'work');
  await page.getByRole('button', { name: 'Complete Oat milk' }).waitFor();
  await showView(page, 'work');
  assert.match(await page.locator('#items').innerText(), /Unsweetened/);
  assert.equal((await local(page)).queue.length, 5);
  await context.setOffline(false);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await confirmed(page);
  assert.equal(records().length, 4);
  const milk = records().find(record => record.title === 'Oat milk');
  assert.equal(milk.listId, null); assert.equal(milk.status, 'inbox'); assert.equal(milk.version, 4);
  assert.equal(milk.originalText, '  milk\n\n bread\neggs  ');
  assert.equal(records().find(record => record.type === 'list').title, 'Weekend groceries');
  await showView(page, 'capture'); await page.locator('#captureText').fill('Phone draft');
  await page.setViewportSize({ width: 390, height: 400 });
  await page.locator('#captureText').focus();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await confirmed(page);
  assert.equal(await page.locator('#captureText').evaluate(element => element === document.activeElement), true);
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.TEST_INBOX_SCREENSHOT) await page.screenshot({ path: process.env.TEST_INBOX_SCREENSHOT, fullPage: true });
});

test('inbox: saved capture and unsubmitted draft survive browser termination and offline launch', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const profile = await mkdtemp(join(tmpdir(), 'todo-inbox-test-'));
  let context;
  t.after(async () => { await context?.close(); await rm(profile, { recursive: true, force: true }); });
  context = await chromium.launchPersistentContext(profile, { channel });
  let page = await context.newPage();
  await page.goto(`${server.url}/inbox.html`);
  await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await capture(page, 'Survive termination');
  await showView(page, 'capture'); await page.locator('#captureText').fill('Still thinking about this');
  // Inspect the same module instance as the app before closing its persistent profile.
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=52')).transact('alice')).draft.capture.text === 'Still thinking about this');
  const beforeClose = await page.evaluate(async () => (await import('/inbox-store.js?v=52')).transact('alice'));
  assert.equal(beforeClose.queue.length, 1);
  await context.close();
  context = await chromium.launchPersistentContext(profile, { channel, offline: true });
  page = await context.newPage();
  await page.goto(`${server.url}/inbox.html`);
  await page.getByRole('button', { name: 'Edit Survive termination', includeHidden: true }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('#captureText').inputValue(), 'Still thinking about this');
  assert.deepEqual((await page.evaluate(async () => (await import('/inbox-store.js?v=52')).transact('alice'))).queue, beforeClose.queue);
  const cached = await page.evaluate(async () => (await (await caches.open('todo-inbox-shell-v52')).keys()).map(request => { const url = new URL(request.url); return url.pathname + url.search; }));
  assert.deepEqual(cached.sort(), ['/clarification-flow.js', '/clarification-flow.js?v=52', '/local-agent.js?v=52', '/shared.html', '/shared.js', '/shared.js?v=52', '/shared.css', '/capture-extraction.js?v=52', '/workspaces.js', '/workspaces.js?v=52', '/briefs.js', '/briefs.js?v=52', '/help.html', '/local-guidance.js?v=52', '/clarification.js', '/clarification.js?v=52', '/reviews.js', '/reviews.js?v=52', '/', '/index.html', '/inbox.css', '/inbox.html', '/inbox.js', '/inbox-store.js', '/inbox-fields.js', '/styles.css', '/theme.js', '/inbox.js?v=52', '/inbox-store.js?v=52', '/inbox-fields.js?v=52', '/pwa.js?v=52', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/inbox-export.js', '/inbox-export.js?v=52'].sort());
  await context.setOffline(false); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' })); await confirmed(page);
  assert.equal(records().length, 1);
});

test('inbox: lost acknowledgement retains exact operation, foreground retry confirms without duplication', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  let original;
  await page.route('**/api/v1/operations', async route => {
    original = route.request().postDataJSON();
    await route.fetch();
    await context.setOffline(true);
    await route.abort();
  });
  await capture(page, 'Only once');
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Sync paused'));
  assert.equal(records().length, 1);
  assert.deepEqual((await local(page)).queue[0].operation, original);
  await page.unroute('**/api/v1/operations');
  await context.setOffline(false); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' })); await confirmed(page);
  assert.equal(records().length, 1); assert.equal((await local(page)).queue.length, 0);
});

test('inbox: switching accounts and expired login never display or upload another account queue', { timeout: 90000 }, async t => {
  const { page, context, setUser } = await setup(t);
  await context.setOffline(true); await capture(page, 'Alice private');
  await showView(page, 'capture'); await page.locator('#captureText').fill('Alice unfinished');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Alice unfinished');
  setUser('bob'); await context.setOffline(false);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).accountId === 'bob');
  assert.doesNotMatch(await page.locator('body').innerText(), /Alice private|Alice unfinished/);
  assert.equal(await page.locator('#captureText').inputValue(), '');
  await capture(page, 'Bob work'); await confirmed(page);
  assert.ok(records().every(record => record.accountId === 'bob'));
  assert.equal((await local(page)).queue.length, 1);
  setUser(null); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await page.locator('#workspace').waitFor({ state: 'hidden' });
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).paused);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true); await page.reload();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Sign in online'));
  assert.equal(await page.locator('#workspace').isVisible(), false);
  setUser('alice'); await context.setOffline(false); await page.reload();
  await page.getByRole('button', { name: 'Edit Alice private', includeHidden: true }).waitFor({ state: 'attached' }); await confirmed(page);
  assert.equal(await page.locator('#captureText').inputValue(), 'Alice unfinished');
  await showView(page, 'work');
  assert.doesNotMatch(await page.locator('#items').innerText(), /Bob work/);
  assert.equal(records().filter(record => record.accountId === 'alice').length, 1);
});

test('inbox: conflict comparison and explicit resolution; deleted records cannot be resurrected', { timeout: 90000 }, async t => {
  const { page, context, url } = await setup(t);
  await capture(page, 'Shared task'); await confirmed(page);
  await context.setOffline(true);
  await showView(page, 'work'); await page.getByRole('button', { name: 'Edit Shared task' }).click();
  await page.locator('#edit [name=title]').fill('Phone version');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await serverEdit(url, records()[0], { title: 'Desktop version' });
  await context.setOffline(false); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await page.locator('#failure').waitFor();
  assert.match(await page.locator('#comparison').textContent(), /Phone version/);
  assert.match(await page.locator('#comparison').textContent(), /Desktop version/);
  assert.equal(records()[0].title, 'Desktop version');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#resolve').click(); await confirmed(page);
  assert.equal(records()[0].title, 'Phone version');
  await context.setOffline(true);
  await showView(page, 'work'); await page.locator('#view').selectOption('all'); await page.locator('#statusFilter').selectOption('@all');
  await showView(page, 'work'); await page.getByRole('button', { name: 'Complete Phone version' }).click();
  await page.getByRole('button', { name: 'Reopen Phone version', includeHidden: true }).waitFor({ state: 'attached' });
  await serverEdit(url, records()[0], null, 'delete');
  await context.setOffline(false); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await page.locator('#failure').waitFor();
  assert.equal(await page.locator('#resolve').isVisible(), false);
  assert.equal(records()[0].deleted, true);
  assert.equal(await page.locator('#items article').count(), 0, 'stale queued completion cannot display a deleted task');
  assert.match(await page.locator('#comparison').textContent(), /Deleted on server/);
  assert.equal((await local(page)).queue.length, 1);
  const download = page.waitForEvent('download'); await clickControl(page.locator('#export'));
  assert.equal((await download).suggestedFilename(), 'todo-device-recovery.json');
});

test('inbox: failed local transaction keeps entered text and recovery copy; queue is bounded', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  await context.setOffline(true);
  await showView(page, 'capture'); await page.locator('#captureText').fill('Keep me after quota failure');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Keep me after quota failure');
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); };
  });
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.locator('#recovery').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'Keep me after quota failure');
  assert.match(await page.locator('#recoveryText').inputValue(), /Keep me after quota failure/);
  assert.equal(await page.locator('#draftStatus').textContent(), 'Not saved on device');
  assert.equal((await local(page)).queue.length, 0);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Keep me after quota failure', includeHidden: true }).waitFor({ state: 'attached' });
  await page.evaluate(async () => {
    const { transact, enqueue, captureMutations } = await import('/inbox-store.js');
    await transact('alice', state => {
      for (let index = state.queue.length; index < 100; index++) enqueue(state, 'alice', captureMutations({ text: `Bounded ${index}` }));
    });
  });
  await showView(page, 'capture'); await page.locator('#captureText').fill('Over the queue limit');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('queue is full'));
  assert.equal((await local(page)).queue.length, 100);
  assert.equal(await page.locator('#captureText').inputValue(), 'Over the queue limit');
});

test('inbox: splitting requires preview confirmation, draft survives reload and competing tabs keep every intent', { timeout: 90000 }, async t => {
  const { page, context, url } = await setup(t);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await showView(page, 'capture'); await page.locator('#captureText').fill('milk, bread; eggs');
  await showView(page, 'capture'); await page.locator('#captureOptions > summary').click();
  await page.locator('#previewSplit').click();
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.locator('#captureText').inputValue(), 'milk\nbread\neggs');
  await showView(page, 'capture'); await page.locator('#captureText').fill('oat milk\nbread\neggs');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'oat milk\nbread\neggs');
  await page.reload();
  await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'oat milk\nbread\neggs');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.getByRole('button', { name: 'Edit oat milk', includeHidden: true }).waitFor({ state: 'attached' });
  assert.ok((await local(page)).queue[0].operation.mutations.every(mutation => mutation.fields.originalText === 'milk, bread; eggs'));
  const second = await context.newPage(); await second.goto(`${url}/inbox.html`);
  await second.locator('#workspace').waitFor();
  await Promise.all([capture(page, 'Tab one'), capture(second, 'Tab two')]);
  assert.equal((await local(page)).queue.length, 3);
  await context.setOffline(false);
  await Promise.all([clickControl(page.getByRole('button', { name: 'Sync now', includeHidden: true })), clickControl(second.getByRole('button', { name: 'Sync now', includeHidden: true }))]);
  await confirmed(page); await confirmed(second);
  assert.equal(records().length, 5);
  assert.equal(documents.filter(doc => doc.kind === 'receipt').length, 3);
});

test('inbox: editor storage failure closes the sheet and exposes a recovery copy', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  await capture(page, 'Original task'); await confirmed(page);
  await context.setOffline(true);
  await showView(page, 'work'); await page.getByRole('button', { name: 'Edit Original task', exact: true }).click();
  await page.locator('#edit [name=title]').fill('Recover this sheet draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.edit?.fields.title === 'Recover this sheet draft');
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); };
  });
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#recovery').waitFor();
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.match(await page.locator('#recoveryText').inputValue(), /Recover this sheet draft/);
  await page.locator('#recoveryText').focus();
  assert.ok(await page.locator('#recoveryText').evaluate(el => el === document.activeElement));
  assert.equal(records()[0].title, 'Original task');
});

test('retired shell explains recovery and every legacy mutation stays read-only', async t => {
  const server = await startServer({ browserUser: true }); t.after(server.close);
  process.env.V1_CLIENT_ENABLED = 'true';
  try {
    const response = await fetch(`${server.url}/api/app`);
    assert.equal(response.status, 410);
    assert.match(await response.text(), /durable inbox/);
    const { routes } = await import('./harness.mjs');
    for (const route of routes.keys()) {
      if (!route.startsWith('POST ') || /\/(v1|shared)\//.test(route)) continue;
      const rejected = await fetch(`${server.url}${route.slice(5)}`, { method: 'POST', headers: { origin: server.url } });
      assert.equal(rejected.status, 409, route);
      assert.match(await rejected.text(), /durable inbox/);
    }
  } finally { delete process.env.V1_CLIENT_ENABLED; }
});

test('inbox: aborted transaction never reports saved; keyboard double activation creates only one intent', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  await context.setOffline(true);
  await showView(page, 'capture'); await page.locator('#captureText').fill('Atomic save');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Atomic save');
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const result = window.originalPut.apply(this, args), transaction = this.transaction;
      result.addEventListener('success', () => transaction.abort());
      return result;
    };
  });
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.locator('#recovery').waitFor();
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.locator('#captureText').inputValue(), 'Atomic save');
  assert.equal(await page.locator('#draftStatus').textContent(), 'Not saved on device');
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = window.originalPut;
    const form = document.querySelector('#capture'); form.requestSubmit(); form.requestSubmit();
  });
  await page.getByRole('button', { name: 'Edit Atomic save', includeHidden: true }).waitFor({ state: 'attached' });
  assert.equal((await local(page)).queue.length, 1);
  await showView(page, 'capture'); await page.locator('#captureText').fill('Keyboard save');
  await page.locator('#captureText').press('Control+Enter');
  await page.getByRole('button', { name: 'Edit Keyboard save', includeHidden: true }).waitFor({ state: 'attached' });
  assert.equal((await local(page)).queue.length, 2);
  assert.equal(await page.locator('#captureText').evaluate(element => element === document.activeElement), true);
});

test('inbox: rejected server write stays failed and recoverable until explicitly removed', { timeout: 90000 }, async t => {
  const { page } = await setup(t);
  await page.route('**/api/v1/operations', route => route.fulfill({ status: 400, contentType: 'application/json',
    body: JSON.stringify({ apiVersion: 1, error: 'invalid_request', message: 'The destination needs correction.' }) }));
  await capture(page, 'Recover rejected text');
  await page.locator('#failure').waitFor();
  await showView(page, 'work');
  assert.match(await page.locator('#items').innerText(), /Failed/);
  assert.equal((await local(page)).queue.length, 1);
  await page.reload();
  await page.locator('#failure').waitFor();
  assert.match(await page.locator('#comparison').textContent(), /Recover rejected text/);
  assert.equal(records().length, 0);
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#discard').click(); await confirmed(page);
  assert.equal((await local(page)).queue.length, 0);
});

for (const oldVersion of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]) test(`shell upgrade from v${oldVersion} preserves old account cache, draft and exact queued operation without mixed modules`, { timeout: 90000 }, async t => {
  documents.length = 0;
  let oldWorker = true, rejectUpgrade = false, rejectOperations = true;
  const server = await startServer({ browserUser: () => 'alice', rejectOperations: () => rejectOperations, assetContents: path => oldWorker && path === '/inbox-sw.js' ? `
    const paths = ['/inbox.js', '/inbox-store.js', '/inbox-fields.js',
      ...(${oldVersion} >= 30 ? ['/shared.js'] : []),
      ...(${oldVersion} >= 4 ? ['/inbox.js?v=${oldVersion}', '/inbox-store.js?v=${oldVersion}', '/inbox-fields.js?v=${oldVersion}'] : [])];
    self.addEventListener('install', event => event.waitUntil(caches.open('todo-inbox-shell-v${oldVersion}').then(async cache => {
      for (const path of paths) await cache.put(path, new Response('throw new Error("mixed old module")', { headers: { 'content-type': 'text/javascript' } }));
    })));
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.addEventListener('message', event => { if (event.data === 'shell-version') event.ports[0]?.postMessage('todo-inbox-shell-v${oldVersion}'); });
    self.addEventListener('fetch', event => { const url = new URL(event.request.url);
      if (paths.includes(url.pathname + url.search)) event.respondWith(caches.match(event.request));
    });
  ` : rejectUpgrade && path === '/inbox-sw.js' ? "self.addEventListener('install', event => event.waitUntil(Promise.reject(new Error('Injected install failure'))));" : undefined }); t.after(server.close);
  const browser = await chromium.launch({ channel }); t.after(() => browser.close());
  const context = await browser.newContext();
  // Keep one intent unacknowledged at the server, including across worker activation.
  let page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await capture(page, 'Old queued item');
  await showView(page, 'capture'); await page.locator('#captureText').fill('Old unsubmitted draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=52')).transact('alice')).draft.capture.text === 'Old unsubmitted draft');
  const before = await page.evaluate(async () => (await import('/inbox-store.js?v=52')).transact('alice'));
  assert.equal(before.queue.length, 1, 'the upgrade must exercise a pending operation');
  if (oldVersion >= 30) {
    // v30–v32 cached shared.js without a version. The new page must bypass that copy.
    await page.goto(server.url + '/shared.html'); await page.locator('#sharedMain').waitFor();
    await page.goto(server.url); await page.locator('#workspace').waitFor();
  }
  oldWorker = false; rejectUpgrade = true;
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
  await waitForBrowser(page, async () => { const registration = await navigator.serviceWorker.getRegistration(); return !registration.installing && !registration.waiting; });
  assert.ok(await page.evaluate(version => caches.has(`todo-inbox-shell-v${version}`), oldVersion));
  assert.deepEqual((await page.evaluate(async () => (await import('/inbox-store.js?v=52')).transact('alice'))).queue, before.queue);
  rejectUpgrade = false;
  const nextWorker = context.waitForEvent('serviceworker');
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
  const upgradedWorker = await nextWorker;
  await waitForBrowser(page, async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'Old unsubmitted draft');
  assert.deepEqual((await page.evaluate(async () => (await import('/inbox-store.js?v=52')).transact('alice'))).queue, before.queue);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent.includes('close all app tabs'));
  await page.close();
  // Closing a tab and releasing its worker client are asynchronous in Chromium.
  // Reopening early can attach the new page to the old worker and prevent activation.
  await waitForBrowser(upgradedWorker, () => !self.registration.waiting && self.registration.active?.state === 'activated');
  page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  assert.equal(await page.locator('#captureText').inputValue(), 'Old unsubmitted draft');
  assert.equal(await page.evaluate(async operation => (await fetch('/api/v1/operations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation)
  })).status, before.queue[0].operation), 503, 'the outage still applies under the newly active worker');
  assert.equal(records().length, 0, 'no pending write reached storage during the upgrade');
  await context.setOffline(true); await page.reload(); await page.getByRole('button', { name: 'Edit Old queued item', includeHidden: true }).waitFor({ state: 'attached' });
  assert.deepEqual((await local(page)).queue, before.queue);
  rejectOperations = false; await context.setOffline(false);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' })); await confirmed(page);
  assert.equal(records().filter(record => record.type === 'item').length, 1);
  assert.ok(documents.some(doc => doc.id === `receipt:${before.queue[0].operation.operationId}`), 'retry acknowledges the original intent');
  assert.deepEqual(errors, []);
});

test('defaults draft survives reload and failed storage remains recoverable; date conversion rejects DST gaps', { timeout: 90000 }, async t => {
  const { page } = await setup(t, { timezoneId: 'America/New_York' });
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'User defaults', exact: true }));
  await page.locator('#defaultsForm [name=contexts]').fill('@Draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.defaults?.values.contexts === '@Draft');
  await page.reload(); await page.locator('#defaultsEditor').waitFor();
  assert.equal(await page.locator('#defaultsForm [name=contexts]').inputValue(), '@Draft');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { if (this.name === 'accounts') throw new DOMException('Full', 'QuotaExceededError'); return original.apply(this, arguments); };
  });
  await page.getByRole('button', { name: 'Save defaults on device' }).click();
  await page.locator('#recovery').waitFor();
  assert.match(await page.locator('#recoveryText').inputValue(), /@Draft/);
  assert.equal(records().length, 0);
  const dates = await page.evaluate(async () => {
    const { taskFields } = await import('/inbox-fields.js');
    const valid = taskFields({ dueLocal: '2026-07-01T12:00' }).dueDateUtc;
    let gap; try { taskFields({ dueLocal: '2026-03-08T02:30' }); } catch (error) { gap = error.message; }
    return { valid, gap };
  });
  assert.equal(dates.valid, '2026-07-01T16:00:00.000Z'); assert.match(dates.gap, /valid local/);
});

test('independent clients page through all work and resolve defaults conflicts without losing either proposal', { timeout: 90000 }, async t => {
  const { page, browser, url } = await setup(t);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'User defaults', exact: true }));
  await page.getByRole('button', { name: 'Save defaults on device' }).click(); await page.locator('#defaultsEditor').waitFor({ state: 'hidden' }); await confirmed(page);
  // More than one 50-entry change page, using real handlers and independent intents.
  for (let i = 0; i < 52; i++) await serverEdit(url, { type: 'item', id: 'paged-' + i, version: 0 }, { title: 'Page ' + i }, 'create');
  const otherContext = await browser.newContext(); t.after(() => otherContext.close());
  const other = await otherContext.newPage(); await other.goto(url); await other.locator('#workspace').waitFor();
  await other.waitForFunction(() => document.querySelectorAll('#items article').length === 52);
  await clickControl(other.getByRole('button', { includeHidden: true, name: 'User defaults', exact: true }));
  await other.locator('#defaultsForm [name=contexts]').fill('@Laptop');
  await otherContext.setOffline(true);
  await other.getByRole('button', { name: 'Save defaults on device' }).click(); await other.locator('#defaultsEditor').waitFor({ state: 'hidden' });
  const pending = (await local(other)).queue[0].operation;
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'User defaults', exact: true }));
  await page.locator('#defaultsForm [name=contexts]').fill('@Phone');
  await page.getByRole('button', { name: 'Save defaults on device' }).click(); await page.locator('#defaultsEditor').waitFor({ state: 'hidden' }); await confirmed(page);
  await otherContext.setOffline(false); await clickControl(other.getByRole('button', { includeHidden: true, name: 'Sync now' })); await other.locator('#failure').waitFor();
  assert.match(await other.locator('#comparison').textContent(), /@Phone/); assert.match(await other.locator('#comparison').textContent(), /@Laptop/);
  other.once('dialog', dialog => dialog.accept()); await other.locator('#resolve').click(); await confirmed(other);
  const settings = records().find(record => record.type === 'settings'); assert.deepEqual(settings.defaults.contexts, ['@Laptop']);
  assert.equal(settings.version, 3);
  const originalReceipt = documents.find(doc => doc.id === 'receipt:' + pending.operationId).response;
  assert.equal(originalReceipt.status, 'conflict'); assert.deepEqual(originalReceipt.proposed[0].fields.defaults.contexts, ['@Laptop']);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).records['settings:settings'].version === 3);
  assert.equal(await page.locator('#items article').count(), 52);
});
