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
  return { page, context, errors, setUser: value => { user = value; } };
}
async function saveEdit(page) {
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
}
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
    await page.locator('#appMenu').evaluate(el => { el.open = false; });
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
  await showView(page, 'lists');
  assert.equal(await page.locator('#itemsHeading').textContent(), 'Organize');
  assert.equal(await page.title(), 'Organize · Personal');
  assert.equal(await page.locator('#viewLabel').textContent(), 'Choose collection');
  assert.equal(await page.locator('#viewLabel').getAttribute('class'), 'sr-only');
  assert.equal(await page.locator('#view').evaluate(el => getComputedStyle(el).fontSize), await page.locator('#itemsHeading').evaluate(el => getComputedStyle(el).fontSize));
  await page.getByRole('button', { name: /Open Groceries, ready to revisit since 2000-01-01/ }).click();
  const settings = page.locator('#collectionSettingsForm');
  const type = settings.getByRole('combobox', { name: 'Collection type', exact: true });
  assert.equal(await type.inputValue(), 'list');
  assert.equal(await type.locator('option[value="project"]').evaluate(option => option.disabled), true);
  await context.setOffline(true); await page.waitForFunction(() => navigator.onLine === false);
  await type.selectOption('checklist');
  await settings.getByLabel('Revisit on (optional)').fill('2027-01-02');
  await settings.getByRole('button', { name: 'Save collection settings on device' }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=10')).transact('alice');
    return (await import('/inbox-store.js?v=10')).projected(local)['list:groceries']?.kind === 'checklist' &&
      local.queue.some(entry => entry.operation.mutations.some(mutation => mutation.id === 'groceries' && mutation.fields?.revisitDate === '2027-01-02'));
  });
  await page.reload(); await page.locator('#workspace').waitFor();
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
  assert.equal(await page.locator('#executeList option[value="groceries"]').count(), 0);
  await page.locator('[data-execute-kind="checklist"]').click();
  await page.locator('#executeList').selectOption('groceries');
  await page.getByRole('button', { name: 'Edit Buy milk', exact: true }).waitFor();
});

test('collections browser: project settings keep project identity and reusable-reference guidance is explicit', async t => {
  const { page } = await setup(t);
  await showView(page, 'lists'); await page.locator('#view').selectOption('project:kitchen');
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
