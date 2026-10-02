import { test } from 'node:test';
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
  return { ...server, browser, context, page, setUser(value) { user = value; } };
}
async function confirmed(page) {
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
}
async function local(page) {
  return page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
}
async function capture(page, text, newList) {
  await page.locator('#captureText').fill(text);
  if (newList) {
    if (!await page.locator('#captureOptions').getAttribute('open')) await page.locator('#captureOptions summary').click();
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
  assert.match(await page.locator('#syncStatus').innerText(), /1 save.*pending/);
  const queued = await local(page);
  assert.equal(queued.queue[0].operation.mutations.length, 4);
  assert.equal(queued.queue[0].operation.mutations[1].fields.originalText, '  milk\n\n bread\neggs  ');
  assert.equal(records().length, 0);
  await page.reload();
  await page.locator('#items article').first().waitFor();
  await page.getByRole('button', { name: 'Edit milk', exact: true }).click();
  await page.locator('#edit [name=title]').fill('Oat milk');
  await page.locator('#edit [name=description]').fill('Unsweetened\nTwo cartons');
  await page.locator('#edit [name=listId]').selectOption('');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Complete Oat milk' }).click();
  await page.getByRole('button', { name: 'Reopen Oat milk' }).click();
  await page.getByRole('button', { name: 'Edit list: Groceries' }).click();
  await page.locator('#edit [name=title]').fill('Weekend groceries');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  // A click only starts the save. The editor closes after the IDB transaction commits.
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('button', { name: 'Complete Oat milk' }).waitFor();
  assert.match(await page.locator('#items').innerText(), /Unsweetened/);
  assert.equal((await local(page)).queue.length, 5);
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await confirmed(page);
  assert.equal(records().length, 4);
  const milk = records().find(record => record.title === 'Oat milk');
  assert.equal(milk.listId, null); assert.equal(milk.status, 'inbox'); assert.equal(milk.version, 4);
  assert.equal(milk.originalText, '  milk\n\n bread\neggs  ');
  assert.equal(records().find(record => record.type === 'list').title, 'Weekend groceries');
  await page.locator('#captureText').fill('Phone draft');
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
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await capture(page, 'Survive termination');
  await page.locator('#captureText').fill('Still thinking about this');
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Still thinking about this');
  await context.close();
  context = await chromium.launchPersistentContext(profile, { channel, offline: true });
  page = await context.newPage();
  await page.goto(`${server.url}/inbox.html`);
  await page.getByRole('button', { name: 'Edit Survive termination' }).waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'Still thinking about this');
  assert.equal((await local(page)).queue.length, 1);
  const cached = await page.evaluate(async () => (await (await caches.open('todo-inbox-shell-v4')).keys()).map(request => { const url = new URL(request.url); return url.pathname + url.search; }));
  assert.deepEqual(cached.sort(), ['/', '/index.html', '/inbox.css', '/inbox.html', '/inbox.js', '/inbox-store.js', '/inbox-fields.js', '/styles.css', '/theme.js', '/inbox.js?v=4', '/inbox-store.js?v=4', '/inbox-fields.js?v=4'].sort());
  await context.setOffline(false); await page.getByRole('button', { name: 'Sync now' }).click(); await confirmed(page);
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
  await context.setOffline(false); await page.getByRole('button', { name: 'Sync now' }).click(); await confirmed(page);
  assert.equal(records().length, 1); assert.equal((await local(page)).queue.length, 0);
});

test('inbox: switching accounts and expired login never display or upload another account queue', { timeout: 90000 }, async t => {
  const { page, context, setUser } = await setup(t);
  await context.setOffline(true); await capture(page, 'Alice private');
  await page.locator('#captureText').fill('Alice unfinished');
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Alice unfinished');
  setUser('bob'); await context.setOffline(false);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.waitForFunction(() => document.querySelector('#sessionStatus').textContent.includes('bob'));
  assert.doesNotMatch(await page.locator('body').innerText(), /Alice private|Alice unfinished/);
  assert.equal(await page.locator('#captureText').inputValue(), '');
  await capture(page, 'Bob work'); await confirmed(page);
  assert.ok(records().every(record => record.accountId === 'bob'));
  assert.equal((await local(page)).queue.length, 1);
  setUser(null); await page.getByRole('button', { name: 'Sync now' }).click();
  await page.locator('#workspace').waitFor({ state: 'hidden' });
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact(null)).paused);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true); await page.reload();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Sign in online'));
  assert.equal(await page.locator('#workspace').isVisible(), false);
  setUser('alice'); await context.setOffline(false); await page.reload();
  await page.getByRole('button', { name: 'Edit Alice private' }).waitFor(); await confirmed(page);
  assert.equal(await page.locator('#captureText').inputValue(), 'Alice unfinished');
  assert.doesNotMatch(await page.locator('#items').innerText(), /Bob work/);
  assert.equal(records().filter(record => record.accountId === 'alice').length, 1);
});

test('inbox: conflict comparison and explicit resolution; deleted records cannot be resurrected', { timeout: 90000 }, async t => {
  const { page, context, url } = await setup(t);
  await capture(page, 'Shared task'); await confirmed(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Edit Shared task' }).click();
  await page.locator('#edit [name=title]').fill('Phone version');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await serverEdit(url, records()[0], { title: 'Desktop version' });
  await context.setOffline(false); await page.getByRole('button', { name: 'Sync now' }).click();
  await page.locator('#failure').waitFor();
  assert.match(await page.locator('#comparison').textContent(), /Phone version/);
  assert.match(await page.locator('#comparison').textContent(), /Desktop version/);
  assert.equal(records()[0].title, 'Desktop version');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#resolve').click(); await confirmed(page);
  assert.equal(records()[0].title, 'Phone version');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete Phone version' }).click();
  await page.getByRole('button', { name: 'Reopen Phone version' }).waitFor();
  await serverEdit(url, records()[0], null, 'delete');
  await context.setOffline(false); await page.getByRole('button', { name: 'Sync now' }).click();
  await page.locator('#failure').waitFor();
  assert.equal(await page.locator('#resolve').isVisible(), false);
  assert.equal(records()[0].deleted, true);
  assert.equal((await local(page)).queue.length, 1);
  const download = page.waitForEvent('download'); await page.locator('#export').click();
  assert.equal((await download).suggestedFilename(), 'todo-device-recovery.json');
});

test('inbox: failed local transaction keeps entered text and recovery copy; queue is bounded', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  await context.setOffline(true);
  await page.locator('#captureText').fill('Keep me after quota failure');
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Keep me after quota failure');
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
  await page.getByRole('button', { name: 'Edit Keep me after quota failure' }).waitFor();
  await page.evaluate(async () => {
    const { transact, enqueue, captureMutations } = await import('/inbox-store.js');
    await transact('alice', state => {
      for (let index = state.queue.length; index < 100; index++) enqueue(state, 'alice', captureMutations({ text: `Bounded ${index}` }));
    });
  });
  await page.locator('#captureText').fill('Over the queue limit');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('queue is full'));
  assert.equal((await local(page)).queue.length, 100);
  assert.equal(await page.locator('#captureText').inputValue(), 'Over the queue limit');
});

test('inbox: splitting requires preview confirmation, draft survives reload and competing tabs keep every intent', { timeout: 90000 }, async t => {
  const { page, context, url } = await setup(t);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.locator('#captureText').fill('milk, bread; eggs');
  await page.locator('#captureOptions summary').click();
  await page.locator('#previewSplit').click();
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.locator('#captureText').inputValue(), 'milk\nbread\neggs');
  await page.locator('#captureText').fill('oat milk\nbread\neggs');
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'oat milk\nbread\neggs');
  await page.reload();
  await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'oat milk\nbread\neggs');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.getByRole('button', { name: 'Edit oat milk' }).waitFor();
  assert.ok((await local(page)).queue[0].operation.mutations.every(mutation => mutation.fields.originalText === 'milk, bread; eggs'));
  const second = await context.newPage(); await second.goto(`${url}/inbox.html`);
  await second.locator('#workspace').waitFor();
  await Promise.all([capture(page, 'Tab one'), capture(second, 'Tab two')]);
  assert.equal((await local(page)).queue.length, 3);
  await context.setOffline(false);
  await Promise.all([page.getByRole('button', { name: 'Sync now' }).click(), second.getByRole('button', { name: 'Sync now' }).click()]);
  await confirmed(page); await confirmed(second);
  assert.equal(records().length, 5);
  assert.equal(documents.filter(doc => doc.kind === 'receipt').length, 3);
});

test('inbox: editor storage failure closes the sheet and exposes a recovery copy', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  await capture(page, 'Original task'); await confirmed(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Edit Original task', exact: true }).click();
  await page.locator('#edit [name=title]').fill('Recover this sheet draft');
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact('alice')).draft.edit?.fields.title === 'Recover this sheet draft');
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
      if (!route.startsWith('POST ') || route.includes('/v1/')) continue;
      const rejected = await fetch(`${server.url}${route.slice(5)}`, { method: 'POST', headers: { origin: server.url } });
      assert.equal(rejected.status, 409, route);
      assert.match(await rejected.text(), /durable inbox/);
    }
  } finally { delete process.env.V1_CLIENT_ENABLED; }
});

test('inbox: aborted transaction never reports saved; keyboard double activation creates only one intent', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  await context.setOffline(true);
  await page.locator('#captureText').fill('Atomic save');
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text === 'Atomic save');
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
  await page.getByRole('button', { name: 'Edit Atomic save' }).waitFor();
  assert.equal((await local(page)).queue.length, 1);
  await page.locator('#captureText').fill('Keyboard save');
  await page.locator('#captureText').press('Control+Enter');
  await page.getByRole('button', { name: 'Edit Keyboard save' }).waitFor();
  assert.equal((await local(page)).queue.length, 2);
  assert.equal(await page.locator('#captureText').evaluate(element => element === document.activeElement), true);
});

test('inbox: rejected server write stays failed and recoverable until explicitly removed', { timeout: 90000 }, async t => {
  const { page } = await setup(t);
  await page.route('**/api/v1/operations', route => route.fulfill({ status: 400, contentType: 'application/json',
    body: JSON.stringify({ apiVersion: 1, error: 'invalid_request', message: 'The destination needs correction.' }) }));
  await capture(page, 'Recover rejected text');
  await page.locator('#failure').waitFor();
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

test('shell upgrade preserves old account cache, draft and exact queued operation without mixed modules', { timeout: 90000 }, async t => {
  documents.length = 0;
  let oldWorker = true, rejectUpgrade = false;
  const server = await startServer({ browserUser: () => 'alice', assetContents: path => oldWorker && path === '/inbox-sw.js' ? `
    self.addEventListener('install', event => event.waitUntil(caches.open('todo-inbox-shell-v3').then(async cache => {
      await cache.put('/inbox.js', new Response('throw new Error("mixed old module")', { headers: { 'content-type': 'text/javascript' } }));
      await cache.put('/inbox-store.js', new Response('throw new Error("mixed old store")', { headers: { 'content-type': 'text/javascript' } }));
    })));
    self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', event => { const url = new URL(event.request.url);
      if (!url.search && ['/inbox.js', '/inbox-store.js'].includes(url.pathname)) event.respondWith(caches.match(event.request));
    });
  ` : rejectUpgrade && path === '/inbox-sw.js' ? "self.addEventListener('install', event => event.waitUntil(Promise.reject(new Error('Injected install failure'))));" : undefined }); t.after(server.close);
  const browser = await chromium.launch({ channel }); t.after(() => browser.close());
  const context = await browser.newContext();
  // Keep one intent unacknowledged across the upgrade.
  await context.route('**/api/v1/operations', route => route.abort());
  let page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await capture(page, 'Old queued item');
  await page.locator('#captureText').fill('Old unsubmitted draft');
  await page.waitForFunction(async () => (await (await import('/inbox-store.js?v=4')).transact('alice')).draft.capture.text === 'Old unsubmitted draft');
  const before = await page.evaluate(async () => (await import('/inbox-store.js?v=4')).transact('alice'));
  oldWorker = false; rejectUpgrade = true;
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
  await page.waitForFunction(async () => { const registration = await navigator.serviceWorker.getRegistration(); return !registration.installing && !registration.waiting; });
  assert.ok(await page.evaluate(() => caches.has('todo-inbox-shell-v3')));
  assert.deepEqual((await page.evaluate(async () => (await import('/inbox-store.js?v=4')).transact('alice'))).queue, before.queue);
  rejectUpgrade = false;
  await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'Old unsubmitted draft');
  assert.deepEqual((await page.evaluate(async () => (await import('/inbox-store.js?v=4')).transact('alice'))).queue, before.queue);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent.includes('close all app tabs'));
  await page.close(); page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  assert.equal(await page.locator('#captureText').inputValue(), 'Old unsubmitted draft');
  await context.setOffline(true); await page.reload(); await page.getByRole('button', { name: 'Edit Old queued item' }).waitFor();
  assert.deepEqual((await local(page)).queue, before.queue);
  await context.unroute('**/api/v1/operations'); await context.setOffline(false);
  await page.getByRole('button', { name: 'Sync now' }).click(); await confirmed(page);
  assert.equal(records().filter(record => record.type === 'item').length, 1);
  assert.deepEqual(errors, []);
});

test('defaults draft survives reload and failed storage remains recoverable; date conversion rejects DST gaps', { timeout: 90000 }, async t => {
  const { page } = await setup(t, { timezoneId: 'America/New_York' });
  await page.getByRole('button', { name: 'User defaults', exact: true }).click();
  await page.locator('#defaultsForm [name=contexts]').fill('@Draft');
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact('alice')).draft.defaults?.values.contexts === '@Draft');
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
  await page.getByRole('button', { name: 'User defaults', exact: true }).click();
  await page.getByRole('button', { name: 'Save defaults on device' }).click(); await page.locator('#defaultsEditor').waitFor({ state: 'hidden' }); await confirmed(page);
  // More than one 50-entry change page, using real handlers and independent intents.
  for (let i = 0; i < 52; i++) await serverEdit(url, { type: 'item', id: 'paged-' + i, version: 0 }, { title: 'Page ' + i }, 'create');
  const otherContext = await browser.newContext(); t.after(() => otherContext.close());
  const other = await otherContext.newPage(); await other.goto(url); await other.locator('#workspace').waitFor();
  await other.waitForFunction(() => document.querySelectorAll('#items article').length === 52);
  await other.getByRole('button', { name: 'User defaults', exact: true }).click();
  await other.locator('#defaultsForm [name=contexts]').fill('@Laptop');
  await otherContext.setOffline(true);
  await other.getByRole('button', { name: 'Save defaults on device' }).click(); await other.locator('#defaultsEditor').waitFor({ state: 'hidden' });
  const pending = (await local(other)).queue[0].operation;
  await page.getByRole('button', { name: 'User defaults', exact: true }).click();
  await page.locator('#defaultsForm [name=contexts]').fill('@Phone');
  await page.getByRole('button', { name: 'Save defaults on device' }).click(); await page.locator('#defaultsEditor').waitFor({ state: 'hidden' }); await confirmed(page);
  await otherContext.setOffline(false); await other.getByRole('button', { name: 'Sync now' }).click(); await other.locator('#failure').waitFor();
  assert.match(await other.locator('#comparison').textContent(), /@Phone/); assert.match(await other.locator('#comparison').textContent(), /@Laptop/);
  other.once('dialog', dialog => dialog.accept()); await other.locator('#resolve').click(); await confirmed(other);
  const settings = records().find(record => record.type === 'settings'); assert.deepEqual(settings.defaults.contexts, ['@Laptop']);
  assert.equal(settings.version, 3);
  const originalReceipt = documents.find(doc => doc.id === 'receipt:' + pending.operationId).response;
  assert.equal(originalReceipt.status, 'conflict'); assert.deepEqual(originalReceipt.proposed[0].fields.defaults.contexts, ['@Laptop']);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.waitForFunction(async () => (await (await import('/inbox-store.js')).transact('alice')).records['settings:settings'].version === 3);
  assert.equal(await page.locator('#items article').count(), 52);
});
