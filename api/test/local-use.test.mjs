import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitForBrowser } from './browser-wait.mjs';
import { documents, startServer } from './harness.mjs';
import { digest } from '../api/v1/contract.mjs';

const storeState = (page, owner = 'device-local') => page.evaluate(async accountId => {
  const store = await import('/inbox-store.js?v=17');
  return store.transact(accountId);
}, owner);

async function capture(page, title) {
  await page.locator('#captureText').fill(title);
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
}

test('anonymous workspace saves, reloads and reopens from the cached shell without account API work', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(), accountRequests = [], errors = [];
  page.on('request', request => {
    if (/\/api\/v1\/(changes|operations|records|export)/.test(request.url())) accountRequests.push(request.url());
  });
  page.on('pageerror', failure => errors.push(failure.message));
  await page.goto(server.url);
  await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#sessionStatus').textContent.startsWith('On this device'));
  assert.equal(await page.locator('#accountName').textContent(), 'On this device');
  assert.equal(await page.locator('#connectionLabel').textContent(), 'Saved on this device');
  assert.equal(await page.locator('#signInToSync').getAttribute('hidden'), null);
  await capture(page, 'Anonymous task');
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=17'), local = await store.transact(store.LOCAL_PROFILE);
    return local.queue.length === 1 && store.projected(local)['item:' + local.queue[0].operation.mutations[0].id]?.title === 'Anonymous task';
  });
  const before = await storeState(page);
  assert.equal(before.queue[0].operation.accountId, 'device-local');
  assert.equal(await page.locator('#syncStatus').textContent(), '1 device-only save kept on this device.');
  assert.deepEqual(accountRequests, []);

  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'visible');
  assert.equal(await page.locator('#workspace').isVisible(), true, 'returning to an online local tab keeps its workspace visible');
  await other.close();

  await page.reload();
  await page.getByRole('button', { name: 'Edit Anonymous task', includeHidden: true }).waitFor({ state: 'attached' });
  assert.deepEqual((await storeState(page)).queue, before.queue);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Edit Anonymous task', includeHidden: true }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('#sessionStatus').textContent(), 'On this device · Offline');
  assert.deepEqual((await storeState(page)).queue, before.queue);
  assert.deepEqual(errors, []);
});

test('explicit sign in adopts device-only operations once after pulling existing account records', { timeout: 90000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await capture(page, 'Existing cloud task');
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

  user = null;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#sessionStatus').textContent.startsWith('On this device'));
  await capture(page, 'Adopt me');
  const source = await storeState(page);
  const original = structuredClone(source.queue[0].operation);
  await page.route('**/.auth/login/github?**', async route => {
    user = 'alice';
    await route.fulfill({ status: 302, headers: { location: '/' }, body: '' });
  });
  await page.locator('#appMenu').click();
  await page.getByRole('link', { name: 'Sign in to sync' }).click();
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  const account = await storeState(page, 'alice');
  assert.equal(account.queue.length, 0);
  assert.equal((await storeState(page)).queue.length, 0, 'committed adoption clears the source profile');
  const records = Object.values(account.records).filter(record => record.type === 'item' && !record.deleted);
  assert.deepEqual(records.map(record => record.title).sort(), ['Adopt me', 'Existing cloud task']);
  const receipts = documents.filter(document => document.kind === 'receipt' && document.response?.operationId === original.operationId);
  assert.equal(receipts.length, 1, 'the adopted operation is submitted exactly once');
  assert.equal(receipts[0].requestHash, digest({ ...original, accountId: 'alice' }));
});

test('explicit sign in adopts into an empty account and applies verified task defaults', async t => {
  documents.length = 0;
  let user = null;
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await capture(page, 'First synced task');
  await page.route('**/.auth/login/github?**', async route => {
    user = 'alice';
    await route.fulfill({ status: 302, headers: { location: '/' }, body: '' });
  });
  await page.locator('#appMenu').click();
  await page.getByRole('link', { name: 'Sign in to sync' }).click();
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

  const account = await storeState(page, 'alice');
  assert.equal(account.records[Object.keys(account.records).find(key => key.startsWith('item:'))].title, 'First synced task');
  assert.ok(account.defaultSettings.contexts.includes('@Home'));
  assert.deepEqual((await storeState(page)).queue, []);
});

test('atomic adoption preserves the source on destination recovery and retries without duplication', async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  const result = await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=17');
    const operation = { apiVersion: 1, accountId: store.LOCAL_PROFILE, operationId: 'fixed-operation', mutations: [
      { type: 'item', id: 'fixed-item', action: 'create', expectedVersion: 0,
        fields: { title: 'Exact proposal', workspaceId: 'personal', collectionRefs: [], status: 'inbox' } }
    ] };
    await store.transact(store.LOCAL_PROFILE, local => {
      local.queue = [{ operation }];
      local.draft = { capture: { text: 'Keep local draft' } };
    });
    await store.transact('alice', account => {
      account.records = { 'item:server': { type: 'item', id: 'server', accountId: 'alice', title: 'Confirmed', version: 1, deleted: false } };
      account.after = 7;
      account.draft = { capture: { text: 'Resolve account draft first' } };
    });
    await store.transact(null, session => { session.adoptLocal = 'adopt-exact'; });
    let blocked;
    try { await store.adoptLocalProfile('alice', 'adopt-exact'); } catch (failure) { blocked = failure.message; }
    const sourceAfterBlock = await store.transact(store.LOCAL_PROFILE);
    const destinationAfterBlock = await store.transact('alice');
    const intentAfterBlock = (await store.transact(null)).adoptLocal;
    await store.transact('alice', account => { account.draft = {}; });
    const originalPut = IDBObjectStore.prototype.put;
    let abortAdoption = true;
    IDBObjectStore.prototype.put = function (...args) {
      const request = originalPut.apply(this, args);
      if (abortAdoption && args[1] === 'account:alice') {
        abortAdoption = false;
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    };
    let interrupted;
    try { await store.adoptLocalProfile('alice', 'adopt-exact'); } catch (failure) { interrupted = failure.message; }
    IDBObjectStore.prototype.put = originalPut;
    const sourceAfterInterruption = await store.transact(store.LOCAL_PROFILE);
    const destinationAfterInterruption = await store.transact('alice');
    const intentAfterInterruption = (await store.transact(null)).adoptLocal;
    const adopted = await store.adoptLocalProfile('alice', 'adopt-exact');
    const sourceAfterRetry = await store.transact(store.LOCAL_PROFILE);
    const intentAfterRetry = (await store.transact(null)).adoptLocal;
    await store.transact(store.LOCAL_PROFILE, local => { local.defaultSettings = { statuses: ['inbox'] }; });
    await store.transact(null, session => { session.adoptLocal = 'adopt-empty'; });
    const emptySourceAdoption = await store.adoptLocalProfile('alice', 'adopt-empty');
    return {
      blocked, sourceAfterBlock, destinationAfterBlock, intentAfterBlock, interrupted,
      sourceAfterInterruption, destinationAfterInterruption, intentAfterInterruption, adopted,
      sourceAfterRetry, intentAfterRetry, emptySourceAdoption,
      sourceAfterEmptyAdoption: await store.transact(store.LOCAL_PROFILE)
    };
  });
  assert.match(result.blocked, /unfinished device recovery/);
  assert.equal(result.intentAfterBlock, 'adopt-exact');
  assert.equal(result.sourceAfterBlock.queue[0].operation.operationId, 'fixed-operation');
  assert.equal(result.destinationAfterBlock.draft.capture.text, 'Resolve account draft first');
  assert.match(result.interrupted, /abort|failed/i);
  assert.equal(result.sourceAfterInterruption.queue[0].operation.operationId, 'fixed-operation');
  assert.equal(result.destinationAfterInterruption.records['item:server'].title, 'Confirmed');
  assert.equal(result.destinationAfterInterruption.queue.length, 0);
  assert.equal(result.intentAfterInterruption, 'adopt-exact');
  assert.equal(result.adopted.after, 7);
  assert.equal(result.adopted.records['item:server'].title, 'Confirmed');
  assert.equal(result.adopted.queue.length, 1);
  assert.equal(result.adopted.queue[0].operation.accountId, 'alice');
  assert.equal(result.adopted.queue[0].operation.operationId, 'fixed-operation');
  assert.equal(result.adopted.queue[0].operation.mutations[0].fields.title, 'Exact proposal');
  assert.equal(result.sourceAfterRetry.queue.length, 0);
  assert.equal(result.intentAfterRetry, false);
  assert.equal(result.emptySourceAdoption.queue[0].operation.operationId, 'fixed-operation', 'an empty local profile does not block existing account recovery');
  assert.equal(result.sourceAfterEmptyAdoption.defaultSettings, undefined);
});

test('a verified session without the initiating tab intent does not adopt device-only work', async t => {
  documents.length = 0;
  let user = null;
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await capture(page, 'Keep device-only');
  const source = await storeState(page);
  await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=17');
    await store.transact(null, session => { session.adoptLocal = 'abandoned-intent'; });
  });

  user = 'alice';
  await page.reload();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=17'), session = await store.transact(null);
    return session.activeProfile === 'alice' && !document.querySelector('#workspace').hidden;
  });
  assert.equal(await page.locator('#accountName').textContent(), 'Your account');
  assert.deepEqual((await storeState(page)).queue, source.queue);
  assert.equal((await storeState(page, 'alice')).queue.length, 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /Keep device-only/);
  assert.equal(documents.some(document => document.kind === 'receipt'), false);
});
