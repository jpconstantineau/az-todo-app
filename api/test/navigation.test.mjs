import { clickControl, openMenu } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { showView } from './navigation-helper.mjs';

const local = page => page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
async function setup(t, hash = '') {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url + '/' + hash); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  return { ...server, page, context, browser, setUser(value) { user = value; } };
}
async function capture(page, title, list = '') {
  await showView(page, 'capture');
  await page.locator('#captureText').fill(title);
  if (list) {
    await page.locator('#captureOptions').evaluate(element => { element.open = true; });
    await page.locator('#capture [name=newList]').fill(list);
  }
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
}

test('navigation: incomplete defaults, completed recovery and all statuses work across views and offline reload', { timeout: 90000 }, async t => {
  const { page, context, url, setUser } = await setup(t, '#work');
  const response = await fetch(`${url}/api/v1/operations`, {
    method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
      { type: 'list', id: 'list', action: 'create', expectedVersion: 0, fields: { title: 'Errands' } },
      { type: 'project', id: 'project', action: 'create', expectedVersion: 0, fields: { title: 'Launch', outcome: 'Ready to launch' } },
      ...[
        ['done', { title: 'Finished task', status: 'completed', listId: 'list', projectId: 'project', plannedDay: '2026-10-02' }],
        ['next', { title: 'Next task', status: 'next', listId: 'list', projectId: 'project', plannedDay: '2026-10-02' }],
        ['inbox', { title: 'Inbox task', status: 'inbox' }],
        ['waiting', { title: 'Waiting task', status: 'waiting', waitingOn: 'Alex', reviewDate: '2026-10-05' }],
        ['deferred', { title: 'Deferred task', status: 'deferred', startDate: '2026-10-05' }]
      ].map(([id, fields]) => ({ type: 'item', id, action: 'create', expectedVersion: 0, fields }))
    ] })
  });
  assert.equal(response.status, 200, await response.text());
  await clickControl(page.locator('#sync'));
  // An empty outbox is already "server-confirmed" before the change feed arrives.
  await page.getByRole('button', { name: 'Complete Next task', exact: true }).waitFor();
  assert.equal(await page.locator('#statusFilter').inputValue(), '');
  assert.equal(await page.locator('#items article').count(), 4);
  assert.equal(await page.getByRole('button', { name: 'Reopen Finished task', exact: true }).count(), 0);
  for (const view of ['project:project', 'day', 'list']) {
    await page.locator('#view').selectOption(view);
    if (view === 'day') await page.locator('#day').fill('2026-10-02');
    assert.deepEqual(await page.locator('#items h3').allTextContents(), ['Next task']);
    await page.locator('#statusFilter').selectOption('completed');
    assert.deepEqual(await page.locator('#items h3').allTextContents(), ['Finished task']);
    await page.locator('#statusFilter').selectOption('@all');
    assert.equal(await page.locator('#items article').count(), 2);
    await page.locator('#statusFilter').selectOption('');
  }
  await page.locator('#view').selectOption('inbox');
  assert.equal(await page.locator('#items article').count(), 3);
  await page.locator('#statusFilter').selectOption('completed');
  assert.equal(await page.locator('#items article').count(), 0, 'completed filter still respects the inbox');
  await page.locator('#view').selectOption('project:project');
  await context.setOffline(true);
  await showView(page, 'lists'); await page.locator('#view').selectOption('list');
  assert.equal(await page.locator('#statusFilter').inputValue(), '', 'list view starts incomplete independently');
  await page.getByRole('button', { name: 'Complete Next task', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('#items article').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement.id === 'itemsHeading');
  assert.match(await page.locator('#items').innerText(), /Choose Completed or All statuses/);
  await showView(page, 'work');
  assert.equal(await page.locator('#statusFilter').inputValue(), 'completed');
  assert.equal(await page.locator('#items article').count(), 2);
  await page.locator('#statusFilter').selectOption('@all');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.navigation.work.status === '@all');
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#statusFilter').inputValue(), '@all');
  assert.equal(await page.locator('#items article').count(), 2);
  await showView(page, 'lists');
  assert.equal(await page.locator('#statusFilter').inputValue(), '');
  assert.equal(await page.locator('#items article').count(), 0);
  await page.locator('#statusFilter').selectOption('completed');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.navigation.lists.status === 'completed');
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#statusFilter').inputValue(), 'completed');
  await page.getByRole('button', { name: 'Reopen Next task', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen Next task', exact: true }).waitFor({ state: 'detached' });
  await page.locator('#statusFilter').selectOption('');
  assert.deepEqual(await page.locator('#items h3').allTextContents(), ['Next task']);
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  const records = documents.filter(doc => doc.record?.type === 'item').map(doc => doc.record);
  assert.equal(records.length, 5, 'filtering and reopening never clone or delete tasks');
  assert.equal(records.find(record => record.id === 'next').status, 'next');
  assert.equal(records.find(record => record.id === 'done').status, 'completed');
  setUser('bob'); await page.reload(); await page.locator('#workspace').waitFor();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).accountId === 'bob');
  await showView(page, 'work');
  assert.equal(await page.locator('#statusFilter').inputValue(), '');
  assert.equal(await page.locator('#items article').count(), 0);
});

test('navigation: new lists open only on request and resume the same draft after online and offline reloads', { timeout: 90000 }, async t => {
  const { page, context, setUser } = await setup(t);
  assert.equal(await page.locator('#editor').isVisible(), false);
  await showView(page, 'lists');
  assert.equal(await page.locator('#editor').isVisible(), false);
  await page.locator('#newList').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.edit?.type === 'list');
  const id = (await local(page)).draft.edit.id;
  await page.locator('#cancelEdit').click();
  await page.reload(); await confirmed(page);
  assert.equal(await page.locator('#editor').isVisible(), false, 'a blank list draft must not open on load');
  await page.locator('#newList').click();
  await page.locator('#edit [name=title]').fill('Weekend groceries');
  await page.locator('#edit [name=description]').fill('Keep these unsaved notes');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.edit?.fields.description === 'Keep these unsaved notes');
  assert.equal((await local(page)).draft.edit.id, id);
  await context.setOffline(true);
  // Even an interrupted open panel stays closed on the next visit.
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#editor').isVisible(), false);
  await showView(page, 'capture');
  await page.locator('#captureText').fill('Separate capture draft');
  await showView(page, 'lists');
  await page.locator('#newList').click();
  assert.equal(await page.locator('#edit [name=title]').inputValue(), 'Weekend groceries');
  assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Keep these unsaved notes');
  assert.ok(await page.locator('#edit [name=title]').evaluate(el => el === document.activeElement));
  await page.keyboard.press('Escape');
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.equal((await local(page)).draft.edit.id, id);
  assert.deepEqual((await local(page)).queue, []);
  await page.locator('#newList').click();
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal((await local(page)).queue[0].operation.mutations[0].id, id);
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(documents.filter(doc => doc.record?.type === 'list').length, 1);
  await page.locator('#newList').click();
  assert.equal(await page.locator('#edit [name=title]').inputValue(), '');
  await page.locator('#edit [name=title]').fill('Alice private list draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.edit?.fields.title === 'Alice private list draft');
  await page.locator('#cancelEdit').click();
  setUser('bob'); await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).accountId === 'bob');
  await showView(page, 'lists'); await page.locator('#newList').click();
  assert.equal(await page.locator('#edit [name=title]').inputValue(), '');
});

test('navigation: distinct views preserve offline capture, filters, editor drafts and exact intents through history and reload', { timeout: 90000 }, async t => {
  const { page, context, url } = await setup(t);
  assert.equal(await page.locator('#quickFocus').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.work-panel').isVisible(), false);
  await context.setOffline(true);
  await capture(page, 'Milk\nBread', 'Groceries');
  const before = (await local(page)).queue;
  const listId = before[0].operation.mutations[0].id;
  await page.locator('#captureText').fill('Unsubmitted capture');
  await showView(page, 'work');
  assert.equal(await page.locator('#captureText').isVisible(), false);
  assert.equal(await page.locator('#newList').isVisible(), false);
  assert.equal(await page.locator('#items article').count(), 2);
  await page.locator('#view').selectOption('inbox');
  await page.locator('#statusFilter').selectOption('next');
  await showView(page, 'lists');
  assert.match(await page.locator('#items').innerText(), /Choose a list/);
  assert.equal(await page.locator('#view option[value="all"]').count(), 0);
  assert.equal(await page.locator('#newProject').isVisible(), false);
  await page.locator('#view').selectOption(listId);
  await page.locator('#statusFilter').selectOption('inbox');
  assert.equal(await page.locator('#items article').count(), 2);
  await page.getByRole('button', { name: 'Edit Milk', exact: true }).click();
  await page.locator('#edit [name=description]').fill('Keep this editor draft');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await showView(page, 'capture');
  assert.equal(await page.locator('#captureText').inputValue(), 'Unsubmitted capture');
  assert.deepEqual((await local(page)).queue, before);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#listWorkspace').getAttribute('aria-current') === 'page');
  assert.equal(await page.locator('#view').inputValue(), listId);
  assert.equal(await page.locator('#statusFilter').inputValue(), 'inbox');
  assert.equal(await page.locator('#itemsHeading').evaluate(el => el === document.activeElement), true);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#yourWork').getAttribute('aria-current') === 'page');
  assert.equal(await page.locator('#view').inputValue(), 'inbox');
  assert.equal(await page.locator('#statusFilter').inputValue(), 'next');
  await page.goForward(); await page.reload();
  await page.locator('#editor').waitFor();
  assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Keep this editor draft');
  assert.equal(await page.locator('#view').inputValue(), listId);
  assert.deepEqual((await local(page)).queue, before);
  // Browser history can change while a native modal is open; keep focus in it.
  await page.evaluate(() => { location.hash = 'capture'; });
  await page.waitForFunction(() => document.querySelector('#quickFocus').getAttribute('aria-current') === 'page');
  assert.ok(await page.locator('#editor').evaluate(el => el.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  await page.locator('#editor').waitFor({ state: 'hidden' });
  // Native close events run after the key event; wait for the promised focus result.
  await page.waitForFunction(() => document.activeElement.id === 'captureText');
  assert.ok(await page.locator('#captureText').evaluate(el => el === document.activeElement));
  await showView(page, 'lists');
  await page.getByRole('button', { name: 'Edit Milk', exact: true }).click();
  await page.locator('#edit [name=listId]').selectOption('');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#items article').count(), 1);
  await showView(page, 'work'); await page.locator('#statusFilter').selectOption('@all');
  await page.getByRole('button', { name: 'Complete Milk', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen Milk', exact: true }).waitFor();
  await showView(page, 'capture');
  assert.equal(await page.locator('#captureText').inputValue(), 'Unsubmitted capture');
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  const records = documents.filter(doc => doc.kind === 'record').map(doc => doc.record);
  assert.equal(records.length, 3);
  assert.equal(records.find(record => record.title === 'Milk').description, 'Keep this editor draft');
  assert.equal(records.find(record => record.title === 'Milk').status, 'completed');
  assert.equal(records.find(record => record.title === 'Milk').originalText, 'Milk\nBread');
  // Opening a plain URL is a fresh Capture destination; a direct URL restores its view.
  await page.goto(url); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#quickFocus').getAttribute('aria-current'), 'page');
  await page.goto(url + '/#lists'); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#view').inputValue(), listId);
  assert.equal(await page.locator('#listWorkspace').getAttribute('aria-current'), 'page');
  await page.goto(url + '/#unknown'); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#quickFocus').getAttribute('aria-current'), 'page');
});

test('navigation: failures stay reachable in every view, deleted selections clear, and accounts cannot inherit navigation state', { timeout: 90000 }, async t => {
  const { page, context, setUser } = await setup(t, '#lists');
  assert.match(await page.locator('#items').innerText(), /No lists yet/);
  await capture(page, 'Private task', 'Private list'); await confirmed(page);
  const list = documents.find(doc => doc.record?.type === 'list').record;
  await showView(page, 'lists'); await page.locator('#view').selectOption(list.id);
  await page.locator('#statusFilter').selectOption('next');
  await page.route('**/api/v1/operations', route => route.fulfill({ status: 400, json: { apiVersion: 1, error: 'invalid_request', message: 'Keep this rejected save.' } }));
  await capture(page, 'Rejected private task'); await page.locator('#failure').waitFor();
  await page.locator('#captureText').fill('Private unsaved draft');
  for (const view of ['work', 'lists', 'capture']) {
    await showView(page, view);
    assert.ok(await page.locator('#failure').isVisible());
    assert.ok(await page.locator('#discard').isVisible());
    await openMenu(page);
    assert.ok(await page.locator('#sync').isVisible());
    assert.ok(await page.locator('#export').isVisible());
    assert.match(await page.locator('#comparison').textContent(), /Rejected private task/);
  }
  await context.setOffline(true);
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await page.locator('#captureText').fill('Recover this draft'); await page.locator('#recovery').waitFor();
  for (const view of ['work', 'lists', 'capture']) {
    await showView(page, view);
    assert.ok(await page.locator('#recovery').isVisible());
    assert.match(await page.locator('#recoveryText').inputValue(), /Recover this draft/);
    await page.locator('#copyRecovery').focus();
    assert.ok(await page.locator('#copyRecovery').evaluate(el => el === document.activeElement));
  }
  await page.reload(); await page.locator('#workspace').waitFor();
  // Simulate the normal change feed replacing a selected list with its tombstone.
  await page.evaluate(async id => {
    await (await import('/inbox-store.js')).transact('alice', local => { local.records['list:' + id].deleted = true; });
  }, list.id);
  await page.reload(); await page.locator('#workspace').waitFor(); await showView(page, 'lists');
  assert.equal(await page.locator('#view').inputValue(), '');
  assert.match(await page.locator('#items').innerText(), /No lists yet/);
  setUser('bob'); await context.setOffline(false); await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).accountId === 'bob');
  await page.waitForFunction(() => document.querySelector('#quickFocus').getAttribute('aria-current') === 'page');
  assert.doesNotMatch(await page.locator('body').innerText(), /Private list|Private task|Rejected private task|Recover this draft/);
  assert.equal(await page.locator('#statusFilter').inputValue(), '');
  assert.equal(await page.locator('#failure').isVisible(), false);
  await showView(page, 'lists'); assert.equal(await page.locator('#view').inputValue(), '');
  setUser(null); await clickControl(page.locator('#sync')); await page.locator('#workspace').waitFor({ state: 'hidden' });
  await page.evaluate(() => { location.hash = 'work'; });
  assert.equal(await page.locator('.work-panel').isVisible(), false);
});

test('navigation: keyboard links, responsive layout and appearance across all three destinations', { timeout: 90000 }, async t => {
  const { page } = await setup(t);
  await capture(page, 'Buy milk\nBook a bike tune-up', 'Weekend'); await confirmed(page);
  const list = documents.find(doc => doc.record?.type === 'list').record;
  await showView(page, 'lists'); await page.locator('#view').selectOption(list.id);
  await showView(page, 'capture');
  await page.locator('#quickFocus').focus(); await page.keyboard.press('Tab');
  assert.ok(await page.locator('#yourWork').evaluate(el => el === document.activeElement));
  assert.equal(await page.locator('#yourWork').evaluate(el => getComputedStyle(el).outlineWidth), '3px');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'itemsHeading');
  const shots = process.env.NAVIGATION_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const theme of ['dark', 'light']) {
    await clickControl(page.getByRole('button', { includeHidden: true, name: 'Preferences', exact: true }));
    await page.locator('[data-appearance]').selectOption(theme);
    await page.getByRole('button', { name: 'Close preferences', exact: true }).click();
    for (const width of [320, 390, 768, 1440, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['capture', 'work', 'lists']) {
        await showView(page, view);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width} ${view}`);
        assert.equal(await page.locator('.workspace-nav [aria-current="page"]').count(), 1);
        assert.equal(await page.locator('.inbox-grid > section:visible:not(#failure)').count(), 1);
        for (const link of await page.locator('.workspace-nav a').all()) assert.ok((await link.boundingBox()).height >= 44);
        if (shots && [390, 1440].includes(width) && (theme === 'dark' || view === 'work')) {
          await page.locator('.workspace-nav [aria-current="page"]').focus();
          await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
          await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({ path: `${shots}/navigation-${view}-${theme}-${width}.png`, fullPage: true });
        }
      }
    }
  }
  // Reflow and 200% text enlargement; physical browser zoom/phone keyboards remain manual checks.
  await page.setViewportSize({ width: 720, height: 450 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  for (const view of ['capture', 'work', 'lists']) {
    await showView(page, view);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.locator('.skip-link').focus(); await page.keyboard.press('Enter');
  assert.ok(await page.locator('#itemsHeading').evaluate(el => el === document.activeElement));
});
