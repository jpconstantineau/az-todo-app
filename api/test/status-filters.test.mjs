import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { defaultSettings } from '../api/shared/defaults.mjs';

test('status filters: inclusion, exclusion, scopes, offline persistence and account isolation', { timeout: 90000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const response = await fetch(`${server.url}/api/v1/operations`, {
    method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
      { type: 'list', id: 'list', action: 'create', expectedVersion: 0, fields: { title: 'Errands', defaults: { ...defaultSettings, statuses: ['next', 'completed', 'dropped', 'custom <status>'] } } },
      { type: 'project', id: 'project', action: 'create', expectedVersion: 0, fields: { title: 'Launch', outcome: 'Ready' } },
      ...['next', 'completed', 'dropped', 'custom <status>'].map((status, i) => ({
        type: 'item', id: `item-${i}`, action: 'create', expectedVersion: 0,
        fields: { title: status, status, listId: 'list', projectId: 'project', plannedDay: '2026-10-02' }
      })),
      { type: 'item', id: 'inbox', action: 'create', expectedVersion: 0, fields: { title: 'Unfiled', status: 'inbox' } }
    ] })
  });
  assert.equal(response.status, 200, await response.text());
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  const rows = () => page.locator('#items article').evaluateAll(items => items.map(item => item.dataset.id).sort());
  const status = name => page.getByRole('checkbox', { name, exact: true });
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await page.waitForFunction(() => document.querySelectorAll('#items article').length === 4);
  const before = structuredClone(documents);
  await page.locator('#statusFilter').selectOption('@include');
  assert.deepEqual(await rows(), []);
  await status('next').focus(); await page.keyboard.press('Space');
  assert.ok(await status('next').evaluate(input => input === document.activeElement), 'keyboard focus survives rendering');
  await status('custom <status>').check();
  assert.deepEqual(await rows(), ['item-0', 'item-3']);
  assert.equal(await page.locator('#statusChoices status').count(), 0, 'custom names stay text');
  await page.locator('#statusFilter').selectOption('@exclude');
  assert.deepEqual(await rows(), ['inbox', 'item-1', 'item-2']);
  await status('next').uncheck(); await status('custom <status>').uncheck();
  assert.equal((await rows()).length, 5, 'empty exclusion shows all statuses');
  await status('Completed').check(); await status('dropped').check();
  assert.deepEqual(await rows(), ['inbox', 'item-0', 'item-3']);
  await page.locator('#view').selectOption('day'); await page.locator('#day').fill('2026-10-02');
  for (const view of ['list', 'project:project', 'day']) {
    await page.locator('#view').selectOption(view);
    assert.deepEqual(await rows(), ['item-0', 'item-3'], view);
  }
  await page.locator('#view').selectOption('inbox'); assert.deepEqual(await rows(), ['inbox']);
  await page.locator('#view').selectOption('all');
  await showView(page, 'lists'); await page.locator('#view').selectOption('list');
  assert.equal(await page.locator('#statusFilter').inputValue(), '');
  await page.locator('#statusFilter').selectOption('@include'); await status('Completed').check();
  assert.deepEqual(await rows(), ['item-1']);
  await showView(page, 'work');
  assert.equal(await page.locator('#statusFilter').inputValue(), '@exclude');
  assert.deepEqual(await rows(), ['inbox', 'item-0', 'item-3']);
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js')).transact('alice');
    return local.draft.navigation?.work.statuses.includes('dropped') && local.draft.navigation?.lists.statuses.includes('completed');
  });
  await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#statusFilter').inputValue(), '@exclude');
  assert.ok(await status('Completed').isChecked()); assert.ok(await status('dropped').isChecked());
  assert.deepEqual(await rows(), ['inbox', 'item-0', 'item-3']);
  await showView(page, 'lists'); assert.deepEqual(await rows(), ['item-1']);
  await showView(page, 'work');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const label of await page.locator('#statusChoices label').all()) assert.ok((await label.boundingBox()).height >= 44);
  }
  if (process.env.STATUS_FILTER_SCREENSHOTS) {
    await mkdir(process.env.STATUS_FILTER_SCREENSHOTS, { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: `${process.env.STATUS_FILTER_SCREENSHOTS}/statuses-${width}.png`, fullPage: true });
    }
  }
  const local = await page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
  assert.deepEqual(local.queue, []); assert.deepEqual(documents, before, 'filtering never mutates tasks');
  user = 'bob'; await context.setOffline(false); await page.reload(); await page.locator('#workspace').waitFor();
  await showView(page, 'work');
  assert.equal(await page.locator('#statusFilter').inputValue(), '');
  assert.equal(await page.locator('#statusSelection').isVisible(), false);
  await page.locator('#statusFilter').selectOption('@include');
  assert.equal(await page.locator('#statusChoices input:checked').count(), 0);
  assert.equal(await status('custom <status>').count(), 0);
});
