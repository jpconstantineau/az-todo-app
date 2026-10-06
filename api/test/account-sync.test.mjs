import { clickControl } from './navigation-helper.mjs';
import { showView } from './navigation-helper.mjs';
import { test } from 'node:test';
import { waitForBrowser } from './browser-wait.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';

const records = () => documents.filter(doc => doc.kind === 'record').map(doc => doc.record);
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const label = (page, expected) => page.waitForFunction(value => document.querySelector('#sessionStatus').textContent === value, expected);
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=5')).transact('alice'));
async function setup(t) {
  documents.length = 0;
  Object.assign(faults, { nextWrite: false, batchIndex: -1, loseBatchResponse: false });
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  return { ...server, browser, context, page, setUser(value) { user = value; } };
}
async function open(page, url) {
  await page.goto(url);
  await page.locator('#workspace').waitFor(); await confirmed(page);
}
async function capture(page, text) {
  await showView(page, 'capture'); await page.locator('#captureText').fill(text);
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
}
async function edit(page, title, replacement) {
  await showView(page, 'work'); await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
  await page.locator('#edit [name=title]').fill(replacement);
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
}
async function sync(page) {
  const response = page.waitForResponse(response => response.url().includes('/api/v1/changes?'));
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  const changes = await (await response).json();
  // Headers and an unchanged confirmation label do not mean this pull was applied.
  await waitForBrowser(page, async ({ accountId, highWater }) => {
    const state = await (await import('/inbox-store.js?v=5')).transact(accountId);
    if (state.after < highWater || state.queue.length) return false;
    const items = Object.values(state.records).filter(record => record.type === 'item' && !record.deleted);
    const rendered = [...document.querySelectorAll('#items article')];
    return rendered.length === items.length && items.every(record => rendered.some(article =>
      article.dataset.id === record.id && article.querySelector('h3').textContent === record.title));
  }, changes);
  await confirmed(page);
}

test('account label: verified name is text only; rename does not change ownership or cache auth', async t => {
  const { page, context, url } = await setup(t);
  let name = '<img src=x onerror=alert(1)>', requests = 0;
  await page.route('**/.auth/me', route => {
    requests++;
    return route.fulfill({ json: { clientPrincipal: { userId: 'alice', userDetails: name } } });
  });
  await open(page, url); await label(page, `Device inbox for ${name}`);
  assert.equal(await page.locator('#sessionStatus img').count(), 0);
  assert.equal(await page.locator('#accountName').textContent(), name);
  assert.equal(await page.locator('#accountName img').count(), 0);
  await capture(page, 'Milk'); await confirmed(page);
  assert.equal(records()[0].accountId, 'alice');
  const id = records()[0].id;
  name = 'renamed-handle'; await sync(page); await label(page, 'Device inbox for renamed-handle');
  assert.equal(records()[0].id, id);
  assert.equal((await local(page)).records[`item:${id}`].accountId, 'alice');
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key =>
    (await (await caches.open(key)).keys()).map(request => request.url)))).flat());
  assert.ok(cached.every(url => !url.includes('/.auth/') && !url.includes('/api/')));
  await context.setOffline(true); await page.reload();
  await page.locator('#workspace').waitFor(); await label(page, 'Your device inbox · Offline');
  assert.equal(await page.locator('#accountName').textContent(), 'renamed-handle');
  assert.ok(requests > 0);
});

test('account label: missing, malformed, mismatched and failed profiles leave capture usable', async t => {
  const { page, url } = await setup(t);
  const bodies = [null, {}, { clientPrincipal: null }, { clientPrincipal: [] },
    { clientPrincipal: { userId: 'alice', userDetails: {} } },
    { clientPrincipal: { userId: 'alice', userDetails: '  ' } },
    { clientPrincipal: { userId: 'bob', userDetails: 'wrong-person' } }];
  let body = bodies[0], status = 200, invalidJson = false;
  await page.route('**/.auth/me', route => route.fulfill({ status, contentType: 'application/json', body: invalidJson ? '{' : JSON.stringify(body) }));
  await open(page, url);
  for (body of bodies) { await sync(page); await label(page, 'Your device inbox'); }
  for (status of [401, 500]) { await sync(page); await label(page, 'Your device inbox'); }
  status = 200; invalidJson = true; await sync(page); await label(page, 'Your device inbox');
  await capture(page, 'Profile is optional'); await confirmed(page);
  assert.equal(records()[0].title, 'Profile is optional');
});

test('account label: delayed previous-account responses and expiry cannot restore a name', async t => {
  const { page, url, setUser } = await setup(t);
  const pending = [];
  let hold = true;
  await page.route('**/.auth/me', route => {
    if (hold) { pending.push(route); return; }
    return route.fulfill({ json: { clientPrincipal: { userId: 'bob', userDetails: 'bob-handle' } } });
  });
  await open(page, url);
  // A hung profile does not hold the workspace or the sync queue hostage.
  await capture(page, 'Alice item'); await confirmed(page);
  hold = false; setUser('bob'); await sync(page); await label(page, 'Device inbox for bob-handle');
  assert.equal(await page.locator('#items article').count(), 0);
  for (const route of pending) await route.fulfill({ json: { clientPrincipal: { userId: 'alice', userDetails: 'late-alice' } } });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await label(page, 'Device inbox for bob-handle');
  assert.equal(await page.locator('#accountName').textContent(), 'bob-handle');
  setUser(null); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await page.locator('#workspace').waitFor({ state: 'hidden' });
  assert.doesNotMatch(await page.locator('#sessionStatus').textContent(), /bob-handle|late-alice/);
  assert.equal(await page.locator('#accountName').textContent(), 'Welcome');
});

test('account label: timed-out profile keeps the neutral label and durable capture', { timeout: 30000 }, async t => {
  const { page, url } = await setup(t);
  await page.route('**/.auth/me', () => {});
  const timeout = page.waitForEvent('requestfailed', request => request.url().endsWith('/.auth/me'));
  await open(page, url); await capture(page, 'Still saved'); await confirmed(page);
  await timeout; await label(page, 'Your device inbox');
  assert.equal(records()[0].title, 'Still saved');
});

test('account label: explicit sign-out clears the label and pauses the original account', async t => {
  const { page, url } = await setup(t);
  await page.route('**/.auth/me', route => route.fulfill({ json: { clientPrincipal: { userId: 'alice', userDetails: 'alice-handle' } } }));
  // A 204 keeps this page alive so the pre-navigation cleanup can be inspected.
  await page.route('**/.auth/logout?**', route => route.fulfill({ status: 204 }));
  await open(page, url); await label(page, 'Device inbox for alice-handle');
  await showView(page, 'capture'); await page.locator('#captureText').fill('Keep this draft');
  await clickControl(page.locator('#signOut'));
  await page.locator('#workspace').waitFor({ state: 'hidden' });
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=5')).transact(null)).paused);
  assert.doesNotMatch(await page.locator('#sessionStatus').textContent(), /alice-handle/);
  assert.equal((await local(page)).draft.capture.text, 'Keep this draft');
});

test('same-profile tabs share their unsaved draft slot; independent profiles do not', async t => {
  const { page, context, browser, url } = await setup(t);
  await open(page, url); await showView(page, 'capture'); await page.locator('#captureText').fill('First tab draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=5')).transact('alice')).draft.capture.text === 'First tab draft');
  const second = await context.newPage(); await open(second, url);
  assert.equal(await second.locator('#captureText').inputValue(), 'First tab draft');
  await showView(second, 'capture'); await second.locator('#captureText').fill('Shared replacement');
  await waitForBrowser(second, async () => (await (await import('/inbox-store.js?v=5')).transact('alice')).draft.capture.text === 'Shared replacement');
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'Shared replacement');
  const independent = await browser.newContext(), third = await independent.newPage();
  await open(third, url); assert.equal(await third.locator('#captureText').inputValue(), '');
});

test('independent browser profiles sync records, preserve offline conflicts and block later work', { timeout: 60000 }, async t => {
  const { browser, context: phoneContext, page: phone, url } = await setup(t);
  const laptopContext = await browser.newContext();
  const laptop = await laptopContext.newPage();
  await open(phone, url); await open(laptop, url);
  await capture(phone, 'Milk\nBread'); await confirmed(phone);
  assert.equal((await local(laptop)).after, 0, 'independent IndexedDB and no cross-device broadcast');
  // Reproduce a slow consumer after response headers arrive, as on the CI runner.
  await laptop.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (response.url.includes('/api/v1/changes?')) {
        window.fetch = fetch;
        const json = response.json.bind(response);
        response.json = async () => { const body = await json(); await new Promise(resolve => setTimeout(resolve, 500)); return body; };
      }
      return response;
    };
  });
  await sync(laptop); assert.equal(await laptop.locator('#items article').count(), 2);
  await phoneContext.setOffline(true); await laptopContext.setOffline(true);
  await edit(phone, 'Milk', 'Oat milk'); await edit(laptop, 'Bread', 'Rye bread');
  await phoneContext.setOffline(false); await sync(phone);
  await laptopContext.setOffline(false); await sync(laptop); await sync(phone);
  assert.deepEqual(records().map(record => record.title).sort(), ['Oat milk', 'Rye bread']);
  await phoneContext.setOffline(true); await laptopContext.setOffline(true);
  await edit(phone, 'Oat milk', 'Phone milk'); await edit(laptop, 'Oat milk', 'Laptop milk');
  await capture(laptop, 'Behind conflict');
  const proposal = (await local(laptop)).queue[0].operation;
  await phoneContext.setOffline(false); await sync(phone);
  await laptopContext.setOffline(false); await clickControl(laptop.locator('#sync'));
  await laptop.locator('#failure').waitFor();
  assert.deepEqual((await local(laptop)).queue[0].operation, proposal);
  assert.equal((await local(laptop)).queue.length, 2);
  assert.ok(!records().some(record => record.title === 'Behind conflict'));
  assert.match(await laptop.locator('#comparison').textContent(), /Laptop milk/);
  assert.match(await laptop.locator('#comparison').textContent(), /Phone milk/);
  laptop.on('dialog', dialog => dialog.accept());
  await laptop.locator('#resolve').click(); await confirmed(laptop); await sync(phone);
  assert.ok(records().some(record => record.title === 'Laptop milk'));
  assert.ok(records().some(record => record.title === 'Behind conflict'));
  assert.deepEqual((await local(phone)).records, (await local(laptop)).records);
  // Identical text submitted as separate intents is two records, not deduplication.
  await capture(phone, 'Same text'); await confirmed(phone);
  await capture(laptop, 'Same text'); await confirmed(laptop); await sync(phone);
  assert.equal(records().filter(record => record.title === 'Same text').length, 2);
});
