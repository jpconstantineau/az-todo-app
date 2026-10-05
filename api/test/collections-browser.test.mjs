import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { showView, clickControl } from './navigation-helper.mjs';
import { currentCreate } from './current-record.mjs';

const create = currentCreate;
const ref = (type, id) => ({ type, id });
const synced = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=2')).transact('alice'));
async function setup(t, items = []) {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const seeds = [create('list', 'home', { title: 'Home', kind: 'area' }), create('list', 'role', { title: 'Parent', kind: 'role' }), create('project', 'kitchen', { title: 'Kitchen', outcome: 'Working kitchen', parentRef: ref('list', 'home') }), create('list', 'packing', { title: 'Packing', kind: 'reference', parentRef: ref('list', 'home') }), ...items];
  for (let i = 0; i < seeds.length; i += 20) {
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: seeds.slice(i, i + 20) }) });
    assert.equal(response.status, 200, await response.text());
  }
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await synced(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  return { page, context, setUser: value => { user = value; } };
}
async function saveEdit(page) {
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
}
test('collections browser: one editor creates kinds and parents; offline multi-membership and rollups keep one item', async t => {
  const { page, context } = await setup(t, [create('item', 'task', { title: 'Measure cabinets', status: 'next' })]);
  await showView(page, 'lists'); await page.locator('#newList').click();
  await page.locator('#edit [name=kind]').selectOption('program'); await page.locator('#edit [name=title]').fill('Family plans');
  await page.locator('#edit [name=parentRef]').selectOption('list:home'); await saveEdit(page); await synced(page);
  const created = Object.values((await local(page)).records).find(record => record.title === 'Family plans');
  assert.equal(created.kind, 'program'); assert.deepEqual(created.parentRef, ref('list', 'home'));
  await showView(page, 'work'); await page.locator('#view').selectOption('all');
  await page.getByRole('button', { name: 'Edit Measure cabinets', exact: true }).click();
  await context.setOffline(true);
  await page.locator('#edit [name=collectionRefs]').selectOption(['project:kitchen', 'list:home', 'list:role']);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=2')).transact('alice')).draft.edit?.fields.collectionRefs?.length === 3);
  await page.reload(); await page.locator('#editor').waitFor();
  assert.equal(await page.locator('#edit [name=collectionRefs] option:checked').count(), 3);
  await saveEdit(page);
  await showView(page, 'lists'); await page.locator('#view').selectOption('home'); await page.locator('#includeNested').check();
  assert.equal(await page.locator('#items article[data-id=task]').count(), 1);
  await page.locator('#view').selectOption('project:kitchen');
  await page.getByRole('button', { name: 'Edit Measure cabinets', exact: true }).waitFor();
  assert.match(await page.locator('#collectionBreadcrumbs').textContent(), /Home \/ Kitchen/);
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true })); await synced(page);
  assert.equal(documents.filter(doc => doc.id === 'record:item:task').length, 1);
  if (process.env.COLLECTION_SCREENSHOTS) {
    await page.locator('#appMenu').evaluate(el => { el.open = false; });
    await mkdir(process.env.COLLECTION_SCREENSHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${process.env.COLLECTION_SCREENSHOTS}/lists-${theme}-${width}.png`, fullPage: true });
    }
  }
});
test('collections browser: reusable reference checklist and resumable area mapping preserve source and tags', async t => {
  const entries = Array.from({ length: 21 }, (_, i) => create('item', `tag-${i}`, { title: `Tagged ${i}`, areas: ['Household'], status: 'inbox' }));
  const { page, context } = await setup(t, [create('item', 'passport', { title: 'Passport', description: 'Check expiry', status: 'reference', listId: 'packing', referenceLinks: ['https://example.com/passport'] }), ...entries]);
  await showView(page, 'lists'); await page.locator('#view').selectOption('packing');
  await page.getByRole('button', { name: 'Edit Passport', exact: true }).waitFor();
  await page.locator('#collectionUtilities > summary').click();
  await page.locator('#collectionUtilityForm [name=entries]').selectOption('passport');
  await page.locator('#collectionUtilityForm [name=title]').fill('November trip');
  await context.setOffline(true);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=2')).transact('alice')).draft.collectionUtility?.title === 'November trip');
  await page.evaluate(() => {
    window.collectionPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value?.queue?.some(entry => entry.operation.mutations.some(m => m.type === 'list' && m.fields?.title === 'November trip'))) throw new DOMException('Checklist quota failure', 'QuotaExceededError');
      return window.collectionPut.call(this, value, ...args);
    };
  });
  await page.getByRole('button', { name: 'Save collection action on device' }).click();
  await page.waitForFunction(() => document.querySelector('#collectionUtilityStatus').textContent.includes('Checklist quota failure'));
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.locator('#collectionUtilityForm [name=title]').inputValue(), 'November trip');
  assert.equal(await page.locator('#collectionUtilityForm [name=entries]').inputValue(), 'passport');
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.collectionPut; });
  await page.getByRole('button', { name: 'Save collection action on device' }).click();
  await page.waitForFunction(() => document.querySelector('#collectionUtilityStatus').textContent.includes('New checklist saved'));
  const state = await local(page), copies = state.queue.flatMap(entry => entry.operation.mutations).filter(m => m.type === 'item');
  assert.equal(copies.length, 1); assert.notEqual(copies[0].id, 'passport'); assert.equal(copies[0].fields.status, 'inbox'); assert.equal(copies[0].fields.description, 'Check expiry');
  assert.equal(state.records['item:passport'].status, 'reference');
  await page.locator('#collectionUtilityForm [name=mode]').selectOption('area');
  await page.locator('#collectionUtilityForm [name=tag]').selectOption('Household');
  await page.locator('#collectionUtilityForm [name=target]').selectOption('list:home');
  await page.getByRole('button', { name: 'Save collection action on device' }).click();
  await page.waitForFunction(() => document.querySelector('#collectionUtilityStatus').textContent.includes('1 item(s) remain'));
  await page.reload(); await page.locator('#workspace').waitFor(); await page.locator('#collectionUtilities > summary').click();
  assert.equal(await page.locator('#collectionUtilityForm [name=target]').inputValue(), 'list:home');
  await page.getByRole('button', { name: 'Save collection action on device' }).click();
  await page.waitForFunction(() => document.querySelector('#collectionUtilityStatus').textContent.includes('0 item(s) remain'));
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true })); await synced(page);
  const tagged = documents.filter(doc => doc.record?.id.startsWith('tag-')).map(doc => doc.record);
  assert.equal(tagged.length, 21); assert.ok(tagged.every(item => item.areas[0] === 'Household' && item.collectionRefs.some(ref => ref.id === 'home')));
});
test('collections browser: clarification uses the organizer and account changes clear private selections', async t => {
  const { page, setUser } = await setup(t, [create('item', 'note', { title: 'Private travel note' })]);
  await showView(page, 'work');
  await clickControl(page.getByRole('button', { name: 'Clarify Private travel note', exact: true, includeHidden: true }));
  await page.locator('[name=flow_choice][value=no]').check(); await page.locator('#clarifyAccept').click();
  await page.locator('select[name=flow_choice]').selectOption('reference'); await page.locator('#clarifyAccept').click();
  await page.locator('[name=flow_collectionRefs]').selectOption(['list:packing', 'list:role']);
  await page.locator('#clarifyAccept').click(); await page.locator('#clarifyAccept').click();
  await page.waitForFunction(() => document.querySelector('#clarifyQuestion').textContent === 'Clarification complete');
  await page.locator('#clarifyStop').click(); await synced(page);
  const item = (await local(page)).records['item:note'];
  assert.equal(item.status, 'reference'); assert.deepEqual(item.collectionRefs.map(ref => ref.id).sort(), ['packing', 'role']);
  await showView(page, 'lists'); await page.locator('#view').selectOption('packing');
  await page.getByRole('button', { name: 'Edit Private travel note', exact: true }).click();
  const selection = page.locator('#edit [name=collectionRefs]');
  await selection.focus(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowDown');
  assert.equal(await selection.evaluate(el => el === document.activeElement), true);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=2')).transact('alice')).draft.edit?.fields.collectionRefs?.length > 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit Private travel note', exact: true }).waitFor();
  setUser('bob'); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=2')).transact(null)).accountId === 'bob'); await synced(page);
  assert.equal(await page.locator('#edit [name=collectionRefs] option').count(), 0);
  assert.doesNotMatch(await page.locator('#collectionOutline').textContent(), /Home|Packing|Parent/);
  assert.equal(await page.locator('#collectionUtilityForm [name=title]').inputValue(), '');
});
