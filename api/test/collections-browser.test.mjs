import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { showView, clickControl } from './navigation-helper.mjs';
import { currentCreate } from './current-record.mjs';
import { defaultSettings } from '../api/shared/defaults.mjs';

const create = currentCreate;
const ref = (type, id) => ({ type, id });
const synced = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=10')).transact('alice'));
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
  return { page, context, errors, server, setUser: value => { user = value; } };
}
async function saveEdit(page) {
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
}

const checklistSeeds = count => [create('list', 'weekly', { title: 'Weekly chores', kind: 'checklist' }),
  ...Array.from({ length: count }, (_, index) => create('item', `chore-${String(index).padStart(2, '0')}`, {
    title: `Chore ${index}`, status: 'completed', description: 'Keep these notes', dueDate: '2026-10-20',
    timeRequired: '60', energy: 'high', collectionRefs: [ref('list', 'weekly'), ref('list', 'role')], listId: 'weekly'
  }))];
const resetOperations = state => state.queue.filter(entry => entry.checklistReset);
async function openChecklist(page, mode = 'execute') {
  await showView(page, mode);
  if (mode === 'execute') {
    await page.locator('[data-execute-kind=checklist]').click(); await page.locator('#executeList').selectOption('weekly');
  } else {
    await page.locator('#view').selectOption('weekly'); await page.locator('#collectionSettingsHeading').click();
  }
}

test('checklist reset: keyboard confirmation, filtered 21-item offline save survives reload and receives each exact receipt once', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t, checklistSeeds(21));
  await openChecklist(page);
  await page.locator('#executeFilterSummary').click();
  await page.locator('#executeTimeFilter').selectOption('5'); await page.locator('#executeEnergyFilter').selectOption('low');
  await context.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
  const reset = page.locator('#resetExecuteChecklist');
  assert.match(await reset.textContent(), /21/);
  await reset.focus();
  page.once('dialog', async dialog => { assert.match(dialog.message(), /regardless of filters.*every collection.*scheduled recurring/); await dialog.dismiss(); });
  await page.keyboard.press('Enter');
  assert.equal(resetOperations(await local(page)).length, 0);
  assert.equal(await reset.evaluate(control => control === document.activeElement), true);
  page.once('dialog', dialog => dialog.accept()); await page.keyboard.press('Enter');
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=22'), state = await store.transact('alice');
    return state.queue.filter(entry => entry.checklistReset).length === 2 && store.projected(state)['item:chore-20'].status === 'next';
  });
  const queued = resetOperations(await local(page));
  assert.deepEqual(queued.map(entry => entry.operation.mutations.length), [20, 1]);
  assert.equal(await page.locator('#executeList').inputValue(), 'weekly');
  assert.equal(await page.locator('#executeTimeFilter').inputValue(), '5');
  assert.equal(await page.locator('#executeEnergyFilter').inputValue(), 'low');
  await page.waitForFunction(() => document.querySelector('#executeChecklistResetStatus').textContent.includes('21 items reopened'));
  assert.match(await page.locator('#executeChecklistResetStatus').textContent(), /pending server confirmation/);
  assert.equal(await reset.isDisabled(), true);
  await page.waitForFunction(() => document.activeElement.id === 'executeList');
  assert.equal(await page.locator('#executeItems article').count(), 0, 'active filters stay applied');
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=22')).transact('alice')).draft.navigation.execute.view === 'weekly');
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.deepEqual(resetOperations(await local(page)), queued, 'reload retains every operation ID, payload and local reset marker');
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true })); await synced(page);
  for (const entry of queued) assert.equal(documents.filter(doc => doc.id === `receipt:${entry.operation.operationId}`).length, 1);
  const records = (await local(page)).records;
  for (let index = 0; index < 21; index++) {
    const item = records[`item:chore-${String(index).padStart(2, '0')}`];
    assert.equal(item.status, 'next'); assert.equal(item.version, 2); assert.equal(item.description, 'Keep these notes');
    assert.equal(item.dueDate, '2026-10-20'); assert.equal(item.nextAction, true); assert.equal(item.completedUtc, null);
    assert.equal(item.workflowBeforeTransition.status, 'completed'); assert.equal(item.collectionRefs.length, 2);
  }
  await clickControl(page.locator('#resetExecuteFilters'));
  assert.equal(await page.locator('#executeItems article').count(), 21);
  await showView(page, 'lists'); await page.locator('#view').selectOption('weekly');
  await page.getByRole('button', { name: 'Undo state change Chore 0', exact: true }).click(); await synced(page);
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=22')).transact('alice');
    return state.records['item:chore-00'].version === 3 && state.records['item:chore-00'].status === 'completed' && !state.queue.length;
  });
  assert.equal((await local(page)).records['item:chore-00'].status, 'completed');
});

test('checklist reset: Organize uses latest direct membership and excludes nested items even with Include nested', { timeout: 90000 }, async t => {
  const { page, context, server } = await setup(t, [...checklistSeeds(2),
    create('list', 'child', { title: 'Nested checklist', kind: 'checklist', parentRef: ref('list', 'weekly') }),
    create('item', 'nested', { title: 'Nested completed', status: 'completed', listId: 'child' }),
    create('item', 'new-member', { title: 'Added completed', status: 'completed' }),
    create('item', 'waiting', { title: 'Waiting deliberately', status: 'waiting', waitingOn: 'Someone', listId: 'weekly' })]);
  const changes = [
    { type: 'item', id: 'chore-00', action: 'update', expectedVersion: 1, fields: { collectionRefs: [ref('list', 'role')], listId: 'role' } },
    { type: 'item', id: 'new-member', action: 'update', expectedVersion: 1, fields: { collectionRefs: [ref('list', 'weekly')], listId: 'weekly' } }
  ];
  const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: changes }) });
  assert.equal(response.status, 200, await response.text());
  await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true })); await synced(page);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=22')).transact('alice')).records['item:new-member'].version === 2);
  await openChecklist(page, 'lists'); await page.locator('#statusFilter').selectOption('waiting'); await page.locator('#includeNested').check();
  assert.match(await page.locator('#resetChecklist').textContent(), /2/);
  await context.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
  page.once('dialog', dialog => dialog.accept()); await clickControl(page.locator('#resetChecklist'));
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=22'), state = await store.transact('alice');
    return store.projected(state)['item:new-member'].status === 'next' && state.queue.some(entry => entry.checklistReset);
  });
  const state = await local(page), changed = resetOperations(state).flatMap(entry => entry.operation.mutations.map(mutation => mutation.id));
  assert.deepEqual(changed.sort(), ['chore-01', 'new-member']);
  assert.equal(await page.locator('#statusFilter').inputValue(), 'waiting'); assert.equal(await page.locator('#includeNested').isChecked(), true);
  assert.match(await page.locator('#checklistResetStatus').textContent(), /2 items reopened/);
  await page.locator('#view').selectOption('home'); assert.equal(await page.locator('#checklistResetStatus').textContent(), '');
});

test('checklist reset: storage failure and stale confirmation leave zero partial local changes', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t, checklistSeeds(21));
  await openChecklist(page);
  await context.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=22')).transact('alice')).draft.navigation.execute.view === 'weekly');
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value.queue?.some(entry => entry.checklistReset)) throw new DOMException('Reset storage quota exceeded', 'QuotaExceededError');
      return window.originalPut.call(this, value, ...args);
    };
  });
  page.once('dialog', dialog => dialog.accept()); await page.locator('#resetExecuteChecklist').click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Reset storage quota exceeded'));
  const failed = await local(page); assert.equal(failed.queue.length, 0);
  assert.ok(Object.values(failed.records).filter(record => record.type === 'item').every(record => record.status === 'completed'));
  assert.equal(await page.locator('#executeChecklistResetStatus').textContent(), '');
  await page.evaluate(async () => {
    IDBObjectStore.prototype.put = window.originalPut;
    const store = await import('/inbox-store.js?v=22');
    window.originalConfirm = window.confirm;
    window.confirm = () => {
      // Queue another tab's durable change before the reset transaction reads.
      window.staleChange = store.transact('alice', state => { state.records['item:chore-20'].version++; state.records['item:chore-20'].collectionRefs = []; });
      return true;
    };
  });
  await page.locator('#resetExecuteChecklist').click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('This checklist changed'));
  await page.evaluate(async () => { await window.staleChange; window.confirm = window.originalConfirm; });
  const stale = await local(page); assert.equal(stale.queue.length, 0);
  assert.ok(Object.values(stale.records).filter(record => record.type === 'item').every(record => record.status === 'completed'));
  assert.equal(await page.locator('#executeChecklistResetStatus').textContent(), '');
});

test('checklist reset: a later chunk conflict pauses without reapplying removed membership or losing earlier receipts; account switch clears acknowledgement', { timeout: 90000 }, async t => {
  const { page, context, server, setUser } = await setup(t, checklistSeeds(21));
  await openChecklist(page); await context.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#resetExecuteChecklist').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=22')).transact('alice')).queue.filter(entry => entry.checklistReset).length === 2);
  const original = resetOperations(await local(page));
  const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
    { type: 'item', id: 'chore-20', action: 'update', expectedVersion: 1, fields: { collectionRefs: [], listId: null } }
  ] }) });
  assert.equal(response.status, 200, await response.text());
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true }));
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=22')).transact('alice');
    return state.queue.length === 1 && state.queue[0].receipt?.status === 'conflict';
  });
  await page.waitForFunction(() => document.querySelector('#failureMessage').textContent.includes('Earlier server-confirmed chunks remain reset'));
  assert.equal(await page.locator('#resolve').isVisible(), false);
  assert.equal(await page.locator('#resetExecuteChecklist').isDisabled(), true);
  assert.equal(documents.filter(doc => doc.id === `receipt:${original[0].operation.operationId}`).length, 1);
  const serverItems = documents.filter(doc => doc.id.startsWith('record:item:')).map(doc => doc.record);
  assert.equal(serverItems.filter(item => item.status === 'next').length, 20);
  await page.evaluate(() => document.querySelector('#resolve').click());
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Keep the server version'));
  assert.equal((await local(page)).queue[0].operation.operationId, original[1].operation.operationId);
  await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true }));
  page.once('dialog', dialog => dialog.accept()); await page.locator('#discard').click(); await synced(page);
  const accepted = (await local(page)).records;
  assert.equal(accepted['item:chore-20'].status, 'completed'); assert.deepEqual(accepted['item:chore-20'].collectionRefs, []);
  assert.equal(Object.values(accepted).filter(record => record.status === 'next').length, 20);
  setUser('bob'); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=22')).transact(null)).accountId === 'bob'); await synced(page);
  assert.equal(await page.locator('#executeChecklistResetStatus').textContent(), '');
  assert.equal(await page.locator('#checklistResetStatus').textContent(), '');
  assert.equal(await page.locator('#resetExecuteChecklist').isVisible(), false);
  assert.equal(await page.locator('#executeList option[value=weekly]').count(), 0);
  assert.deepEqual((await page.evaluate(async () => (await (await import('/inbox-store.js?v=22')).transact('bob')))).queue, []);
});

test('checklist reset: an old account transaction completing after account switch cannot publish its state or acknowledgement', { timeout: 90000 }, async t => {
  const { page, context, server, setUser } = await setup(t, checklistSeeds(1));
  await openChecklist(page); await context.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value.queue?.some(entry => entry.checklistReset)) {
        const transaction = this.transaction, complete = transaction.oncomplete;
        transaction.oncomplete = event => {
          window.resetCommitted = true;
          window.releaseResetCompletion = () => complete.call(transaction, event);
        };
        IDBObjectStore.prototype.put = window.originalPut;
      }
      return window.originalPut.call(this, value, ...args);
    };
  });
  page.once('dialog', dialog => dialog.accept()); await page.locator('#resetExecuteChecklist').click();
  await page.waitForFunction(() => window.resetCommitted === true);
  assert.equal(resetOperations(await local(page)).length, 1, 'the old profile transaction committed durably');
  setUser('bob');
  const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, accountId: 'bob', operationId: crypto.randomUUID(), mutations: [
    create('list', 'bob-weekly', { title: 'Bob chores', kind: 'checklist' }), create('item', 'bob-chore', { title: 'Bob chore', status: 'completed', listId: 'bob-weekly' })
  ] }) });
  assert.equal(response.status, 200, await response.text());
  await context.setOffline(false);
  await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=22')).transact(null)).accountId === 'bob'); await synced(page);
  await showView(page, 'execute'); await page.locator('[data-execute-kind=checklist]').click(); await page.locator('#executeList').selectOption('bob-weekly');
  assert.equal(await page.locator('#resetExecuteChecklist').isDisabled(), true, 'the earlier reset is still completing');
  await page.evaluate(() => window.releaseResetCompletion());
  await page.waitForFunction(() => document.querySelector('#executeChecklistResetStatus').textContent === '' && !document.querySelector('#resetExecuteChecklist').disabled);
  assert.equal(await page.locator('#checklistResetStatus').textContent(), '');
  assert.equal(await page.locator('#executeList option[value=weekly]').count(), 0);
  const bob = await page.evaluate(async () => (await import('/inbox-store.js?v=22')).transact('bob'));
  assert.deepEqual(bob.queue, []); assert.equal(bob.records['item:chore-00'], undefined);
  assert.equal(resetOperations(await local(page)).length, 1, 'the signed-out account keeps its pending work');
});

test('checklist reset: archived workspace keeps the count discoverable and disables both reset controls', { timeout: 90000 }, async t => {
  const { page, server } = await setup(t, [create('workspace', 'work', { title: 'Work' }),
    create('list', 'weekly', { title: 'Weekly chores', kind: 'checklist', workspaceId: 'work' }),
    create('item', 'work-chore', { title: 'Work chore', status: 'completed', workspaceId: 'work', listId: 'weekly' })]);
  const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
    { type: 'workspace', id: 'work', action: 'update', expectedVersion: 1, fields: { archived: true } }
  ] }) });
  assert.equal(response.status, 200, await response.text());
  await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=22')).transact('alice')).records['workspace:work']?.archived === true);
  await page.locator('#workspaceSelect').selectOption('work');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=22')).transact('alice')).selectedWorkspace === 'work');
  await page.waitForFunction(() => document.querySelector('#workspaceStatus').textContent.includes('read-only'));
  await openChecklist(page);
  assert.equal(await page.locator('#resetExecuteChecklist').isVisible(), true);
  assert.equal(await page.locator('#resetExecuteChecklist').isDisabled(), true);
  assert.match(await page.locator('#resetExecuteChecklist').textContent(), /1/);
  await openChecklist(page, 'lists');
  assert.equal(await page.locator('#resetChecklist').isVisible(), true);
  assert.equal(await page.locator('#resetChecklist').isDisabled(), true);
  assert.match(await page.locator('#resetChecklist').textContent(), /1/);
  assert.equal(resetOperations(await local(page)).length, 0);
});
test('collections browser: one editor creates kinds and parents; offline multi-membership and rollups keep one item', async t => {
  const { page, context, errors } = await setup(t, [create('item', 'task', { title: 'Measure cabinets', status: 'next' })]);
  await showView(page, 'lists'); await page.locator('#newList').click();
  await page.locator('#edit [name=kind]').selectOption('program'); await page.locator('#edit [name=title]').fill('Family plans');
  await page.locator('#edit [name=parentRef]').selectOption('list:home'); await saveEdit(page); await synced(page);
  const created = Object.values((await local(page)).records).find(record => record.title === 'Family plans');
  assert.equal(created.kind, 'program'); assert.deepEqual(created.parentRef, ref('list', 'home'));
  await showView(page, 'work'); await page.locator('#view').selectOption('all');
  await page.getByRole('button', { name: 'Edit Measure cabinets', exact: true }).click();
  await context.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false);
  await page.locator('#edit [name=collectionRefs]').selectOption(['project:kitchen', 'list:home', 'list:role']);
  await waitForBrowser(page, async () => {
    const draft = (await (await import('/inbox-store.js?v=10')).transact('alice')).draft;
    return draft.editOpen === true && draft.edit?.fields.collectionRefs?.length === 3;
  });
  await page.reload(); await page.locator('#workspace').waitFor(); assert.deepEqual(errors, []); await page.locator('#editor').waitFor();
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
    await mkdir(process.env.COLLECTION_SCREENSHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${process.env.COLLECTION_SCREENSHOTS}/lists-${theme}-${width}.png`, fullPage: true });
    }
  }
});
test('collections browser: direct settings preserve contents and surface due collections', async t => {
  const defaults = { ...structuredClone(defaultSettings), contexts: ['@Store'] };
  const { page, context } = await setup(t, [
    create('list', 'groceries', { title: 'Groceries', parentRef: ref('list', 'home'), revisitDate: '2000-01-01', defaults }),
    create('item', 'buy-milk', { title: 'Buy milk', status: 'next', listId: 'groceries', collectionRefs: [ref('list', 'groceries')], areas: ['Household'] })
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await showView(page, 'lists');
  assert.equal(await page.locator('#itemsHeading').textContent(), 'Organize');
  assert.equal(await page.title(), 'Organize · Personal');
  assert.equal(await page.locator('#viewLabel').textContent(), 'Choose collection');
  assert.equal(await page.locator('#viewLabel').getAttribute('class'), 'sr-only');
  assert.equal(await page.locator('#view').evaluate(el => getComputedStyle(el).fontSize), await page.locator('#itemsHeading').evaluate(el => getComputedStyle(el).fontSize));
  assert.equal(await page.locator('#collectionSettings').isVisible(), false, 'settings require a selected collection');
  assert.equal(await page.locator('#recurringSection').isVisible(), true, 'recurrence remains available for the workspace');
  assert.equal(await page.locator('#recurringSection').evaluate(details => details.open), false);
  await page.getByRole('button', { name: /Open Groceries, ready to revisit since 2000-01-01/ }).click();
  const settings = page.locator('#collectionSettingsForm');
  assert.equal(await page.locator('.work-panel').evaluate(() => {
    const nodes = ['view', 'collectionBrowser', 'readyToRevisit', 'statusFilter', 'executionFilters', 'items', 'lists', 'collectionSettings', 'recurringSection'].map(id => document.getElementById(id));
    return nodes.slice(1).every((node, index) => nodes[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, 'work and its filters precede management disclosures in reading order');
  assert.ok(await page.locator('#statusFilter').evaluate(el => el.getBoundingClientRect().top < innerHeight));
  const desktopPlacement = await page.locator('#items article').evaluate(el => ({ itemsTop: el.getBoundingClientRect().top, height: innerHeight }));
  assert.ok(desktopPlacement.itemsTop < desktopPlacement.height, `the selected collection work starts in the desktop viewport: ${JSON.stringify(desktopPlacement)}`);
  assert.equal(await page.locator('#collectionSettings').evaluate(details => details.open), false);
  await page.locator('#items button').last().focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#lists button').first().evaluate(el => el === document.activeElement), true, 'task controls precede collection management in tab order');
  await page.locator('#lists button').last().focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#collectionSettingsHeading').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#collectionSettings').evaluate(details => details.open), true);
  await page.locator('#view').selectOption('home');
  assert.equal(await page.locator('#collectionSettings').evaluate(details => details.open), true, 'ordinary collection renders retain disclosure state');
  await page.locator('#view').selectOption('groceries');
  await page.evaluate(() => {
    window.oldOrganizeItem = document.querySelector('#items article');
    document.querySelector('#collectionSettingsHeading').focus();
    const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close();
  });
  await page.waitForFunction(() => !window.oldOrganizeItem.isConnected);
  assert.equal(await page.locator('#collectionSettingsHeading').evaluate(el => el === document.activeElement), true, 'background renders preserve disclosure focus');
  const type = settings.getByRole('combobox', { name: 'Collection type', exact: true });
  assert.equal(await type.inputValue(), 'list');
  assert.equal(await type.locator('option[value="project"]').evaluate(option => option.disabled), true);
  await page.locator('#archiveCollection').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#recurringHeading').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#recurringSection').evaluate(details => details.open), true);
  await context.setOffline(true); await page.waitForFunction(() => navigator.onLine === false);
  await type.selectOption('checklist');
  await settings.getByLabel('Revisit on (optional)').fill('2027-01-02');
  await settings.getByRole('button', { name: 'Save collection settings on device' }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=10')).transact('alice');
    return (await import('/inbox-store.js?v=10')).projected(local)['list:groceries']?.kind === 'checklist' &&
      local.queue.some(entry => entry.operation.mutations.some(mutation => mutation.id === 'groceries' && mutation.fields?.revisitDate === '2027-01-02'));
  });
  assert.equal(await page.locator('#collectionSettings').evaluate(details => details.open), true);
  assert.equal(await page.locator('#recurringSection').evaluate(details => details.open), true);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#collectionSettings').evaluate(details => details.open), false, 'disclosure state is not persisted');
  assert.equal(await page.locator('#recurringSection').evaluate(details => details.open), false, 'recurrence disclosure state is not persisted');
  await page.locator('#collectionSettingsHeading').click();
  assert.equal(await settings.getByLabel('Revisit on (optional)').inputValue(), '2027-01-02');
  const projectedRecords = await page.evaluate(async () => { const store = await import('/inbox-store.js?v=10'); return store.projected(await store.transact('alice')); });
  assert.deepEqual(projectedRecords['list:groceries'].parentRef, ref('list', 'home'));
  assert.equal(projectedRecords['list:groceries'].revisitDate, '2027-01-02');
  assert.deepEqual(projectedRecords['list:groceries'].defaults, defaults);
  assert.equal(projectedRecords['item:buy-milk'].listId, 'groceries');
  assert.deepEqual(projectedRecords['item:buy-milk'].collectionRefs, [ref('list', 'groceries')]);
  assert.deepEqual(projectedRecords['item:buy-milk'].areas, ['Household']);
  assert.equal(await page.locator('#readyToRevisit').isVisible(), false);
  assert.equal(await page.locator('#collectionUtilities').count(), 0);
  await page.setViewportSize({ width: 320, height: 720 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator('#items article').evaluate(el => el.getBoundingClientRect().top < document.querySelector('#collectionSettingsHeading').getBoundingClientRect().top));
  assert.ok(await page.locator('#collectionSettingsHeading, #recurringHeading').evaluateAll(summaries => summaries.every(summary => summary.getBoundingClientRect().height >= 44)));
  await page.locator('#view').selectOption('home');
  assert.equal(await settings.locator('[name=parentRef] option[value="list:groceries"]').count(), 0, 'a descendant cannot become its ancestor\'s parent');
  await page.locator('#view').selectOption('groceries');
  await page.getByRole('button', { name: 'Edit list: Groceries', exact: true }).click();
  assert.equal(await page.locator('#editCollectionFields').isVisible(), false);
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true })); await synced(page);
  const savedLists = documents.filter(doc => doc.id === 'record:list:groceries');
  assert.equal(savedLists.length, 1); assert.equal(savedLists[0].record.kind, 'checklist');
  assert.deepEqual(savedLists[0].record.parentRef, ref('list', 'home'));
  assert.equal(documents.filter(doc => doc.id === 'record:item:buy-milk').length, 1);
  await showView(page, 'execute');
  assert.equal(await page.locator('[data-execute-kind="list"]').isDisabled(), true);
  assert.equal(await page.locator('[data-execute-kind="checklist"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#executeList option[value="groceries"]').count(), 1);
  await page.locator('[data-execute-kind="checklist"]').click();
  await page.locator('#executeList').selectOption('groceries');
  await page.getByRole('button', { name: 'Edit Buy milk', exact: true }).waitFor();
});

test('collections browser: project settings keep project identity and reusable-reference guidance is explicit', async t => {
  const { page } = await setup(t);
  await showView(page, 'lists'); await page.locator('#view').selectOption('project:kitchen');
  await page.locator('#collectionSettingsHeading').click();
  const settings = page.locator('#collectionSettingsForm');
  const type = settings.getByRole('combobox', { name: 'Collection type', exact: true });
  assert.equal(await type.inputValue(), 'project'); assert.equal(await type.isDisabled(), true);
  await settings.getByLabel('Revisit on (optional)').fill('2000-01-01');
  await settings.getByRole('button', { name: 'Save collection settings on device' }).click();
  await page.getByRole('button', { name: /Open Kitchen, ready to revisit since 2000-01-01/ }).waitFor();
  assert.equal((await local(page)).records['project:kitchen'].type, 'project');
  await page.locator('#view').selectOption('packing');
  assert.match(await page.locator('#collectionSettingsHelp').textContent(), /non-actionable source material.*only resurfaces/);
  assert.equal(await type.inputValue(), 'reference');
  assert.equal(await type.locator('option:checked').textContent(), 'Reusable reference');
});
test('collections browser: clarification uses the organizer and account changes clear private selections', async t => {
  const { page, setUser } = await setup(t, [create('item', 'note', { title: 'Private travel note' })]);
  await showView(page, 'work');
  await clickControl(page.getByRole('button', { name: 'Clarify Private travel note', exact: true, includeHidden: true }));
  await page.getByRole('button', { name: /Use .*Packing as parent/ }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /Use Parent as parent/ }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Reference', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyQuestion').textContent === 'Session summary');
  await page.locator('#clarifyStop').click(); await synced(page);
  const item = (await local(page)).records['item:note'];
  assert.equal(item.status, 'reference'); assert.deepEqual(item.collectionRefs.map(ref => ref.id).sort(), ['packing', 'role']);
  await showView(page, 'lists'); await page.locator('#view').selectOption('packing');
  await page.getByRole('button', { name: 'Edit Private travel note', exact: true }).click();
  const selection = page.locator('#edit [name=collectionRefs]');
  await selection.focus(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+ArrowDown');
  assert.equal(await selection.evaluate(el => el === document.activeElement), true);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=10')).transact('alice')).draft.edit?.fields.collectionRefs?.length > 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Edit Private travel note', exact: true }).waitFor();
  setUser('bob'); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=10')).transact(null)).accountId === 'bob'); await synced(page);
  assert.equal(await page.locator('#edit [name=collectionRefs] option').count(), 0);
  assert.doesNotMatch(await page.locator('#collectionOutline').textContent(), /Home|Packing|Parent/);
  assert.equal(await page.locator('#collectionSettings').isVisible(), false);
});

test('collections browser: offline archive hides archive-only work, keeps mixed membership active and reactivates history', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t, [
    create('item', 'archive-only', { title: 'Only in renovation', status: 'inbox', collectionRefs: [ref('project', 'kitchen')], projectId: 'kitchen' }),
    create('item', 'list-primary', { title: 'List primary history', status: 'waiting', waitingOn: 'Archive', collectionRefs: [ref('list', 'home')], listId: 'home' }),
    create('item', 'mixed', { title: 'Mixed errand', status: 'next', collectionRefs: [ref('project', 'kitchen'), ref('list', 'role')], projectId: 'kitchen', listId: 'role' }),
    create('item', 'completed-history', { title: 'Completed history', status: 'completed', collectionRefs: [ref('project', 'kitchen'), ref('list', 'role')], projectId: 'kitchen', listId: 'role' })
  ]);
  await showView(page, 'lists'); await page.locator('#view').selectOption('home');
  await page.locator('#collectionSettingsHeading').click();
  await context.setOffline(true); await page.waitForFunction(() => navigator.onLine === false);
  await page.getByRole('button', { name: 'Archive collection…', exact: true }).click();
  assert.match(await page.locator('#archiveReviewCounts').textContent(), /2 descendant collections/);
  assert.match(await page.locator('#archiveReviewCounts').textContent(), /2 unfinished actions.*archive-only/);
  assert.match(await page.locator('#archiveReviewCounts').textContent(), /1 linked action.*remain active/);
  await page.getByRole('button', { name: 'Archive collection', exact: true }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=13'), state = await store.transact('alice');
    return store.projected(state)['list:home']?.archived === true && state.draft.navigation?.lists?.view === '@archived';
  });
  await page.reload(); await page.locator('#workspace').waitFor(); await page.locator('#archiveBrowser').waitFor();
  assert.equal(await page.locator('#recurringSection').isVisible(), false, 'archive mode hides workspace recurrence management');
  assert.match(await page.locator('#archiveResults').textContent(), /Home/);
  assert.match(await page.locator('#archiveResults').textContent(), /Only in renovation.*Archived with Home/s);
  assert.match(await page.locator('#archiveResults').textContent(), /Mixed errand.*Still active in Parent.*Also archived with Home/s);
  await page.getByText('Inspect retained contents of Kitchen', { exact: true }).click();
  assert.match(await page.locator('#archiveResults').textContent(), /Item \(inbox\): Only in renovation/);
  assert.match(await page.locator('#archiveResults').textContent(), /Item \(completed\): Completed history/);
  await page.getByRole('button', { name: 'Open List primary history', exact: true }).click();
  assert.equal(await page.locator('#edit [name=listId]').inputValue(), 'home');
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  assert.equal(await page.locator('#edit [name=listId]').inputValue(), 'home', 'a background render must retain the archived primary list');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await showView(page, 'work'); await page.locator('#view').selectOption('all');
  await page.getByRole('button', { name: 'Edit Mixed errand', exact: true }).waitFor();
  assert.equal(await page.locator('article[data-id="archive-only"]').count(), 0);
  await showView(page, 'plan');
  assert.equal(await page.locator('#planFocus option').allTextContents().then(values => values.some(value => /Home|Kitchen/.test(value))), false);
  await showView(page, 'lists'); await page.locator('#view').selectOption('@archived');
  await page.getByRole('button', { name: 'Reactivate Home', exact: true }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=13');
    return store.projected(await store.transact('alice'))['list:home']?.archived === false;
  });
  await page.locator('#view').selectOption('project:kitchen');
  await page.getByRole('button', { name: 'Edit Only in renovation', exact: true }).waitFor();
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', exact: true, includeHidden: true })); await synced(page);
});
