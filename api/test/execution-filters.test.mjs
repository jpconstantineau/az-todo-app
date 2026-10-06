import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { currentCreate } from './current-record.mjs';
import { matchesExecutionFilters } from '../../html/inbox-fields.js';

test('execution filters compare limits and retain unspecified or custom estimates', () => {
  const filters = { context: 'context:@Home', minutes: '30', energy: 'medium' };
  const item = { contexts: ['@Work', '@Home'], timeRequired: '30m', energy: 'Low' };
  assert.equal(matchesExecutionFilters(item, filters), true);
  for (const timeRequired of ['31m', '1h', '1.5 hours', '2 HRS']) {
    assert.equal(matchesExecutionFilters({ ...item, timeRequired }, filters), false, timeRequired);
  }
  for (const timeRequired of ['0.5h', '30 minutes', ' 15 MIN ', '', 'quick', '1h 30m']) {
    assert.equal(matchesExecutionFilters({ ...item, timeRequired }, filters), true, timeRequired);
  }
  assert.equal(matchesExecutionFilters({ ...item, energy: 'High' }, filters), false);
  for (const energy of ['Medium', ' low ', '', 'Focused']) {
    assert.equal(matchesExecutionFilters({ ...item, energy }, filters), true, energy);
  }
  assert.equal(matchesExecutionFilters({}, { minutes: '5', energy: 'low' }), true);
  assert.equal(matchesExecutionFilters({}, filters), false);
  assert.equal(matchesExecutionFilters({}, { context: '@none' }), true);
  assert.equal(matchesExecutionFilters(item, { context: '@none' }), false);
  assert.equal(matchesExecutionFilters(item, { context: 'context:@Errands' }), false);
  assert.equal(matchesExecutionFilters(item, {}), true);
});

test('List Workspace filters combine, reset, stay offline and isolate accounts/workspaces while Process stays unfiltered', { timeout: 90000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const items = [
    ['home', { contexts: ['@Home', '@Computer'], timeRequired: '15m', energy: 'Low' }],
    ['long', { contexts: ['@Home'], timeRequired: '1h', energy: 'Low' }],
    ['high', { contexts: ['@Home'], timeRequired: '5m', energy: 'High' }],
    ['unknown', { contexts: ['@Home'] }],
    ['custom', { contexts: ['@Home', '<custom>'], timeRequired: 'quick', energy: 'Focused' }],
    ['errands', { contexts: ['@Errands'], timeRequired: '5m', energy: 'Low' }],
    ['unclassified', {}],
    ['done', { status: 'completed', contexts: ['@Home'], timeRequired: '5m', energy: 'Low' }]
  ];
  const response = await fetch(`${server.url}/api/v1/operations`, {
    method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
      { type: 'workspace', id: 'other', action: 'create', expectedVersion: 0, fields: { title: 'Other work' } },
      currentCreate('list', 'list', { title: 'Home list' }),
      currentCreate('project', 'project', { title: 'Home project', outcome: 'Ready' }),
      ...items.map(([id, fields]) => currentCreate('item', id,
        { title: id, status: 'next', listId: 'list', projectId: 'project', plannedDay: '2026-10-03', ...fields }))
    ] })
  });
  assert.equal(response.status, 200, await response.text());
  const before = structuredClone(documents);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  const rows = () => page.locator('#items article').evaluateAll(items => items.map(item => item.dataset.id).sort());
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor();
  await showView(page, 'lists'); await page.locator('#view').selectOption('list');
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await page.waitForFunction(() => document.querySelectorAll('#items article').length === 7);
  await page.locator('#statusFilter').selectOption('next');
  await page.locator('#executionSummary').focus(); await page.keyboard.press('Enter');
  await page.locator('#contextFilter').selectOption('context:@Home');
  await page.locator('#timeFilter').selectOption('15');
  await page.locator('#energyFilter').focus(); await page.locator('#energyFilter').selectOption('low');
  assert.ok(await page.locator('#energyFilter').evaluate(input => input === document.activeElement));
  assert.deepEqual(await rows(), ['custom', 'home', 'unknown']);
  assert.match(await page.locator('#executionSummary').innerText(), /3 active/);
  await page.locator('#executionSummary').click();
  assert.match(await page.locator('#executionSummary').innerText(), /3 active/);
  await page.locator('#executionSummary').click();
  await page.locator('#statusFilter').selectOption('completed'); assert.deepEqual(await rows(), ['done']);
  await page.locator('#statusFilter').selectOption('@exclude');
  await page.getByRole('checkbox', { name: 'Completed', exact: true }).check();
  assert.deepEqual(await rows(), ['custom', 'home', 'unknown']);
  await page.locator('#contextFilter').selectOption('context:<custom>');
  assert.deepEqual(await rows(), ['custom']); assert.equal(await page.locator('#contextFilter custom').count(), 0);
  await page.locator('#contextFilter').selectOption('@none'); assert.deepEqual(await rows(), ['unclassified']);
  await page.locator('#resetExecutionFilters').click();
  assert.equal(await page.locator('#view').inputValue(), 'list');
  assert.equal(await page.locator('#statusFilter').inputValue(), '@exclude');
  assert.equal((await rows()).length, 7);
  await page.locator('#contextFilter').selectOption('context:@Home');
  await page.locator('#timeFilter').selectOption('15'); await page.locator('#energyFilter').selectOption('low');
  await showView(page, 'work'); await page.locator('#view').selectOption('all');
  assert.equal(await page.locator('#executionFilters').isVisible(), false);
  assert.equal((await rows()).length, 7, 'Process does not apply execution limits');
  await showView(page, 'lists'); assert.deepEqual(await rows(), ['custom', 'home', 'unknown']);
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=7')).transact('alice');
    return local.draft.navigation?.lists.energy === 'low';
  });
  await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor();
  assert.deepEqual(await rows(), ['custom', 'home', 'unknown']);
  assert.match(await page.locator('#executionSummary').innerText(), /3 active/);
  await page.locator('#workspaceSelect').selectOption('other');
  await page.waitForFunction(() => document.querySelector('#contextFilter').value === '');
  assert.equal(await page.locator('#contextFilter option[value="context:<custom>"]').count(), 0);
  await page.locator('#workspaceSelect').selectOption('personal');
  await page.waitForFunction(() => document.querySelector('#contextFilter').value === 'context:@Home');
  assert.deepEqual(await rows(), ['custom', 'home', 'unknown']);
  await page.locator('#executionSummary').click();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const id of ['contextFilter', 'timeFilter', 'energyFilter', 'resetExecutionFilters']) assert.ok((await page.locator('#' + id).boundingBox()).height >= 44);
    if (process.env.EXECUTION_FILTER_SCREENSHOTS) {
      await mkdir(process.env.EXECUTION_FILTER_SCREENSHOTS, { recursive: true });
      await page.locator('#executionSummary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.EXECUTION_FILTER_SCREENSHOTS}/filters-${width}.png` });
    }
  }
  const local = await page.evaluate(async () => (await import('/inbox-store.js?v=7')).transact('alice'));
  assert.deepEqual(local.queue, []); assert.deepEqual(documents, before, 'filters never mutate tasks');
  user = 'bob'; await context.setOffline(false); await page.reload(); await page.locator('#workspace').waitFor();
  await showView(page, 'lists');
  for (const id of ['contextFilter', 'timeFilter', 'energyFilter']) assert.equal(await page.locator('#' + id).inputValue(), '');
  assert.equal(await page.locator('#contextFilter option[value="context:<custom>"]').count(), 0);
});
