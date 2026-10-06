import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { currentCreate } from './current-record.mjs';

const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=4')).transact('alice'));
async function setup(t) {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const response = await fetch(server.url + '/api/v1/operations', {
    method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
      ...['item', 'list', 'project'].map(type => currentCreate(type, type,
        { title: type, ...(type === 'project' ? { outcome: 'Finished outcome' } : {}) })),
      { type: 'workspace', id: 'work', action: 'create', expectedVersion: 0, fields: { title: 'Work' } }
    ] })
  });
  assert.equal(response.status, 200, await response.text());
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 400, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  return { page, context, server, setUser: value => { user = value; } };
}
async function open(page, type) {
  await showView(page, type === 'list' ? 'lists' : 'work');
  await page.locator('#view').selectOption(type === 'project' ? 'project:project' : type === 'list' ? 'list' : 'all');
  await page.getByRole('button', { name: type === 'item' ? 'Edit item' : `Edit ${type}: ${type}`, exact: true }).click();
  await page.locator('#editor').waitFor();
}
const closedAndJournaled = async page => {
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=4')).transact('alice')).draft.editOpen === false);
};

test('interrupted edits restore and dismissed list/project drafts resume with their text intact', { timeout: 90000 }, async t => {
  const { page } = await setup(t);
  for (const type of ['item', 'list', 'project']) {
    await open(page, type);
    await page.locator('#edit [name=description]').fill('Unfinished ' + type);
    await waitForBrowser(page, async type => (await (await import('/inbox-store.js?v=4')).transact('alice')).draft.edit?.fields.description === 'Unfinished ' + type, type);
    await page.reload(); await page.locator('#editor').waitFor();
    assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Unfinished ' + type);
    await page.locator('#cancelEdit').click(); await closedAndJournaled(page);
    await page.reload(); await page.locator('#workspace').waitFor();
    assert.equal(await page.locator('#editor').isVisible(), false);
    await page.locator('#resumeEdit').click();
    assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Unfinished ' + type);
    await page.locator('#edit [type=submit]').click(); await page.locator('#editor').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
    assert.equal(documents.find(doc => doc.record?.type === type).record.description, 'Unfinished ' + type);
  }
});

test('dismissed and unchanged saved editors stay closed for items, lists and projects without mutations', { timeout: 90000 }, async t => {
  const { page, context, server } = await setup(t);
  const before = structuredClone(documents);
  for (const type of ['item', 'list', 'project']) for (const action of ['close', 'escape', 'save']) {
    await open(page, type);
    if (action === 'escape') await page.keyboard.press('Escape');
    else await page.locator(action === 'save' ? '#edit [type=submit]' : '#cancelEdit').click();
    await closedAndJournaled(page);
    assert.equal((await local(page)).draft.edit, null);
    const hash = new URL(page.url()).hash;
    await page.reload(); await page.locator('#workspace').waitFor();
    assert.equal(await page.locator('#editor').isVisible(), false, `${type} ${action}`);
    assert.equal(new URL(page.url()).hash, hash);
    assert.equal(await page.locator('#savedEdit').isVisible(), false);
    assert.deepEqual((await local(page)).queue, []);
  }
  const tab = await context.newPage(); await tab.goto(server.url); await tab.locator('#workspace').waitFor();
  assert.equal(await tab.locator('#editor').isVisible(), false);
  assert.deepEqual(documents, before, 'inspection and unchanged saves never write task records');
});

test('failed draft discard keeps recoverable text and the persisted draft', { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  await open(page, 'item'); await page.locator('#edit [name=description]').fill('Keep on storage failure');
  await page.locator('#cancelEdit').click(); await closedAndJournaled(page);
  const before = (await local(page)).draft.edit;
  await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Full', 'QuotaExceededError'); }; });
  page.once('dialog', dialog => dialog.accept()); await page.locator('#discardEdit').click();
  await page.locator('#recovery').waitFor();
  assert.match(await page.locator('#recoveryText').inputValue(), /Keep on storage failure/);
  assert.deepEqual((await local(page)).draft.edit, before);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#editor').isVisible(), false);
  await page.locator('#resumeEdit').click();
  assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Keep on storage failure');
});

test('dismissed unsaved text can be resumed or discarded offline and stays in its account and workspace', { timeout: 90000 }, async t => {
  const { page, context, server, setUser } = await setup(t);
  await showView(page, 'capture'); await page.locator('#captureText').fill('Separate capture');
  await open(page, 'item'); await page.locator('#edit [name=description]').fill('Private unfinished text');
  await page.locator('#cancelEdit').click(); await closedAndJournaled(page);
  await context.setOffline(true);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.match(await page.locator('#savedEditStatus').innerText(), /Unfinished item edit/);
  for (const width of [320, 400, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('#savedEdit button').evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().height >= 44)));
    if (process.env.EDITOR_SCREENSHOTS) {
      await mkdir(process.env.EDITOR_SCREENSHOTS, { recursive: true });
      await page.locator('#savedEdit').screenshot({ path: `${process.env.EDITOR_SCREENSHOTS}/saved-edit-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 400, height: 844 });
  await page.locator('#resumeEdit').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Private unfinished text');
  assert.equal(await page.locator('#edit [name=title]').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape'); await closedAndJournaled(page);
  await page.locator('#newProject').click();
  assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Private unfinished text', 'opening another record cannot overwrite the draft');
  assert.match(await page.locator('#editError').innerText(), /Save or discard/);
  await page.locator('#cancelEdit').click(); await closedAndJournaled(page);
  await page.locator('#workspaceSelect').selectOption('work');
  // Selecting the option dispatches change; the IndexedDB-backed switch finishes later.
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=4')).transact('alice')).selectedWorkspace === 'work');
  assert.equal(await page.locator('#savedEdit').isVisible(), false);
  await page.locator('#workspaceSelect').selectOption('personal');
  await page.locator('#resumeEdit').waitFor();
  assert.equal(await page.locator('#editor').isVisible(), false);
  const tab = await context.newPage(); await tab.goto(server.url); await tab.locator('#workspace').waitFor();
  assert.equal(await tab.locator('#editor').isVisible(), false);
  await tab.locator('#resumeEdit').click();
  assert.equal(await tab.locator('#edit [name=description]').inputValue(), 'Private unfinished text');
  await tab.locator('#cancelEdit').click(); await closedAndJournaled(tab); await tab.close();
  await context.setOffline(false); setUser('bob');
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#savedEdit').isVisible(), false);
  assert.doesNotMatch(await page.locator('body').innerText(), /Private unfinished text/);
  setUser('alice'); await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#editor').isVisible(), false);
  await page.locator('#resumeEdit').click();
  assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Private unfinished text');
  await page.locator('#cancelEdit').click(); await closedAndJournaled(page);
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#discardEdit').click();
  assert.equal(await page.locator('#savedEdit').isVisible(), true);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#discardEdit').click();
  await page.locator('#savedEdit').waitFor({ state: 'hidden' });
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal((await local(page)).draft.edit, null);
  assert.equal(await page.locator('#captureText').inputValue(), 'Separate capture');
  assert.deepEqual((await local(page)).queue, []);
  assert.equal(documents.find(doc => doc.record?.type === 'item').record.description || '', '');
});
