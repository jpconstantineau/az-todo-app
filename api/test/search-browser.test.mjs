import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { clickControl, showView } from './navigation-helper.mjs';
import { currentCreate } from './current-record.mjs';

const create = currentCreate;
const ref = (type, id) => ({ type, id });
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=14')).transact('alice'));

async function setup(t, mutations) {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  for (let index = 0; index < mutations.length; index += 20) {
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({
      apiVersion: 1, accountId: 'alice', operationId: `search-seed-${index}`, mutations: mutations.slice(index, index + 20)
    }) });
    assert.equal(response.status, 200, await response.text());
  }
  const archiveResponse = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({
    apiVersion: 1, accountId: 'alice', operationId: 'search-archive', mutations: [{ type: 'list', id: 'archive', action: 'update', expectedVersion: 1, fields: { archived: true } }]
  }) });
  assert.equal(archiveResponse.status, 200, await archiveResponse.text());
  for (const operation of [
    { accountId: 'alice', listId: 'shared-search', operationId: 'shared-create', expectedRevision: 0, action: 'create', fields: { title: 'Shared only vault' } },
    { accountId: 'alice', listId: 'shared-search', operationId: 'shared-add', expectedRevision: 1, action: 'add', fields: { id: 'shared-item', title: 'Shared only secret' } }
  ]) {
    const response = await fetch(server.url + '/api/shared/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(operation) });
    assert.equal(response.status, 200, await response.text());
  }
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  return { server, browser, context, page, setUser(value) { user = value; } };
}

async function openSearch(page, workspace = 'work') {
  if (await page.locator('#workspaceSelect').inputValue() !== workspace) {
    await page.locator('#workspaceSelect').selectOption(workspace);
    await page.waitForFunction(id => document.querySelector('#workspaceSelect').value === id, workspace);
  }
  await showView(page, 'work'); await page.locator('#view').selectOption('@search');
  await page.locator('#searchWorkspace').waitFor();
}

const seed = () => [
  create('workspace', 'work', { title: 'Work' }), create('workspace', 'family', { title: 'Family' }),
  create('list', 'roadmap', { title: 'Roadmap', workspaceId: 'work', kind: 'area' }),
  create('list', 'archive', { title: 'Archive vault', workspaceId: 'work' }),
  create('list', 'reference-list', { title: 'Source shelf', workspaceId: 'work', kind: 'reference' }),
  create('project', 'unicode-project', { title: 'Cafe\u0301 🚀', description: 'Launch <b>literally</b>', originalText: '  Exact project source\n', outcome: 'Résumé delivered', workspaceId: 'work', parentRef: ref('list', 'roadmap') }),
  create('item', 'same-active', { title: 'Same title', description: '<img src=x onerror=alert(1)>', originalText: '  Same source <tag>\n', status: 'next', workspaceId: 'work', collectionRefs: [ref('list', 'roadmap')] }),
  create('item', 'same-completed', { title: 'Same title', originalText: 'Completed source', status: 'completed', workspaceId: 'work' }),
  create('item', 'mixed', { title: 'One record many paths', description: 'x'.repeat(4000), status: 'next', workspaceId: 'work', collectionRefs: [ref('list', 'roadmap'), ref('list', 'archive')] }),
  create('item', 'archive-only', { title: 'Archived only', status: 'next', workspaceId: 'work', collectionRefs: [ref('list', 'archive')] }),
  create('item', 'someday', { title: 'Later idea', status: 'someday', workspaceId: 'work' }),
  create('item', 'reference-item', { title: 'Reference item', status: 'reference', workspaceId: 'work' }),
  create('item', 'family-secret', { title: 'Family boundary secret', status: 'next', workspaceId: 'family' })
];

test('workspace search: Unicode fields, visible recovery filters, exact identity, boundaries and keyboard focus', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t, seed());
  await openSearch(page);
  const form = page.locator('#searchForm'), query = form.getByLabel('Search', { exact: true }), type = form.getByLabel('Type'), state = form.getByLabel('State');
  assert.equal(await query.inputValue(), ''); assert.equal(await type.inputValue(), 'all'); assert.equal(await state.inputValue(), 'active');
  assert.match(await page.locator('#searchScope').textContent(), /this device.*Offline.*may be missing/s);
  assert.deepEqual((await page.locator('#searchResults article').evaluateAll(nodes => nodes.map(node => node.dataset.recordKey))).sort(),
    ['item:mixed', 'item:same-active', 'list:roadmap', 'project:unicode-project'].sort());

  await query.fill('CAFÉ'); assert.deepEqual(await page.locator('#searchResults article').evaluateAll(nodes => nodes.map(node => node.dataset.recordKey)), ['project:unicode-project']);
  await query.fill('résumé'); assert.equal(await page.locator('[data-record-key="project:unicode-project"]').count(), 1);
  await query.fill('<B>LITERALLY</B>'); assert.equal(await page.locator('#searchResults img').count(), 0);
  await query.fill('Archive vault'); await state.selectOption('all');
  assert.deepEqual((await page.locator('#searchResults article').evaluateAll(nodes => nodes.map(node => node.dataset.recordKey))).sort(), ['item:archive-only', 'item:mixed', 'list:archive'].sort());
  assert.equal(await page.locator('[data-record-key="item:mixed"]').count(), 1, 'multi-membership has one stable result');
  await query.fill('x'.repeat(200)); assert.deepEqual(await page.locator('#searchResults article').evaluateAll(nodes => nodes.map(node => node.dataset.recordKey)), ['item:mixed']);
  for (const privateText of ['Family boundary secret', 'Shared only secret']) {
    await query.fill(privateText); assert.equal(await page.locator('#searchResults article').count(), 0, privateText);
  }

  await page.locator('#resetSearch').click();
  assert.equal(await query.inputValue(), ''); assert.equal(await type.inputValue(), 'all'); assert.equal(await state.inputValue(), 'active');
  await state.selectOption('status:completed'); assert.equal(await page.locator('[data-record-key="item:same-completed"]').count(), 1);
  await state.selectOption('status:reference');
  assert.deepEqual((await page.locator('#searchResults article').evaluateAll(nodes => nodes.map(node => node.dataset.recordKey))).sort(), ['item:reference-item', 'list:reference-list']);
  await state.selectOption('status:someday'); assert.equal(await page.locator('[data-record-key="item:someday"]').count(), 1);
  await query.fill('Same title'); await state.selectOption('all');
  assert.deepEqual((await page.locator('#searchResults article').evaluateAll(nodes => nodes.map(node => node.dataset.recordKey))).sort(), ['item:same-active', 'item:same-completed']);
  const result = page.locator('[data-focus-key="search:item:same-active:open"]');
  await query.focus();
  for (const control of [type, state, page.locator('#saveSearchView'), page.locator('#resetSearch'), page.locator('#savedViews > summary'), result]) {
    await page.keyboard.press('Tab');
    await page.waitForFunction(focusKey => document.activeElement?.dataset.focusKey === focusKey || document.activeElement?.id === focusKey,
      await control.getAttribute('data-focus-key') || await control.getAttribute('id'));
  }
  await page.keyboard.press('Enter');
  await page.locator('#editor').waitFor();
  assert.equal(await page.locator('#original').textContent(), '  Same source <tag>\n');
  await page.keyboard.press('Escape'); await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.waitForFunction(focusKey => document.activeElement?.dataset.focusKey === focusKey, 'search:item:same-active:open');
  await page.setViewportSize({ width: 320, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const control of await form.locator('input, select, button').all()) assert.ok((await control.boundingBox()).height >= 44);
  await openSearch(page, 'family'); await query.fill('Family boundary secret'); assert.equal(await page.locator('[data-record-key="item:family-secret"]').count(), 1);
  await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#searchHeading').textContent(), 'Search Family');
  assert.equal(await page.locator('[data-record-key="item:family-secret"]').count(), 1);
});

test('saved views: offline lifecycle, cross-device sync, conflict recovery, account isolation and no task mutation', { timeout: 120000 }, async t => {
  const { page, context, browser, server, setUser } = await setup(t, seed());
  await openSearch(page); const form = page.locator('#searchForm');
  await form.getByLabel('Search', { exact: true }).fill('Same title'); await form.getByLabel('State').selectOption('all');
  const tasksBefore = documents.filter(row => row.UserID === 'alice' && row.kind === 'record' && row.record.type === 'item').map(row => structuredClone(row.record));
  await context.setOffline(true); await page.locator('#saveSearchView').click();
  await page.locator('#savedViewForm').getByLabel('View name').fill('Offline view');
  await page.locator('#savedViewForm').getByRole('button', { name: 'Save view on device' }).click();
  await page.locator('#savedViewEditor').waitFor({ state: 'hidden' });
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=14'), state = await store.transact('alice');
    return Object.values(store.projected(state)).some(record => record.type === 'savedView' && record.title === 'Offline view') && state.queue.length === 1;
  });
  await page.reload(); await page.locator('#workspace').waitFor();
  await page.locator('#savedViews summary').click();
  await page.getByRole('button', { name: 'Edit saved view Offline view' }).click();
  await page.locator('#savedViewForm').getByLabel('View name').fill('Edited offline view');
  await page.locator('#savedViewForm').getByLabel('Search', { exact: true }).fill('résumé');
  await page.locator('#savedViewForm').getByRole('button', { name: 'Save view on device' }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=14'), state = await store.transact('alice');
    return Object.values(store.projected(state)).some(record => record.type === 'savedView' && record.title === 'Edited offline view' && record.query === 'résumé');
  });
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Delete saved view Edited offline view' }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=14'), state = await store.transact('alice');
    return Object.values(store.projected(state)).some(record => record.type === 'savedView' && record.deleted);
  });
  assert.deepEqual(documents.filter(row => row.UserID === 'alice' && row.kind === 'record' && row.record.type === 'item').map(row => row.record), tasksBefore);

  await form.getByLabel('Search', { exact: true }).fill('café'); await page.locator('#saveSearchView').click();
  await page.locator('#savedViewForm').getByLabel('View name').fill('Synced Unicode view');
  await page.locator('#savedViewForm').getByRole('button', { name: 'Save view on device' }).click();
  await context.setOffline(false); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' })); await confirmed(page);
  const savedDocument = documents.find(row => row.UserID === 'alice' && row.id.startsWith('record:savedView:') && row.record.title === 'Synced Unicode view');
  assert.ok(savedDocument); const viewId = savedDocument.record.id;

  const otherContext = await browser.newContext(); t.after(() => otherContext.close()); const other = await otherContext.newPage();
  await other.goto(server.url); await other.locator('#workspace').waitFor(); await confirmed(other); await openSearch(other);
  await other.locator('#savedViews summary').click(); await other.getByRole('button', { name: 'Apply saved view Synced Unicode view' }).click();
  assert.equal(await other.locator('#searchForm').getByLabel('Search', { exact: true }).inputValue(), 'café');
  assert.equal(await other.locator('[data-record-key="project:unicode-project"]').count(), 1);

  await context.setOffline(true); await otherContext.setOffline(true);
  await page.getByRole('button', { name: 'Edit saved view Synced Unicode view' }).click();
  await page.locator('#savedViewForm').getByLabel('View name').fill('First device view');
  await page.locator('#savedViewForm').getByRole('button', { name: 'Save view on device' }).click();
  await context.setOffline(false); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' })); await confirmed(page);
  await other.getByRole('button', { name: 'Edit saved view Synced Unicode view' }).click();
  await other.locator('#savedViewForm').getByLabel('View name').fill('Second device view');
  await other.locator('#savedViewForm').getByRole('button', { name: 'Save view on device' }).click();
  await otherContext.setOffline(false); await clickControl(other.getByRole('button', { includeHidden: true, name: 'Sync now' })); await other.locator('#failure').waitFor();
  assert.match(await other.locator('#comparison').textContent(), /Second device view[\s\S]*First device view/);
  other.once('dialog', dialog => dialog.accept()); await other.locator('#resolve').click(); await confirmed(other);
  assert.equal(documents.find(row => row.UserID === 'alice' && row.id === `record:savedView:${viewId}`).record.title, 'Second device view');
  assert.deepEqual(documents.filter(row => row.UserID === 'alice' && row.kind === 'record' && row.record.type === 'item').map(row => row.record), tasksBefore);

  setUser('bob'); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await page.waitForFunction(() => document.querySelector('#workspaceSelect').value === 'personal');
  await showView(page, 'work'); await page.locator('#view').selectOption('@search');
  assert.equal(await page.locator('#savedViewEntries').textContent(), 'No saved views in this workspace.');
  assert.equal(await page.locator('#searchResults article').count(), 0);
});
