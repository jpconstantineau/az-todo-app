import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { documents, startServer } from './harness.mjs';
import { clickControl, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { defaultSettings } from '../api/shared/defaults.mjs';
import { currentCreate } from './current-record.mjs';

test('reference filing survives offline reload, stays retrievable, and leaves execution and review queues', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const create = currentCreate;
  const original = 'Printer uses A4 paper; keep this information for the next refill.';
  const response = await fetch(server.url + '/api/v1/operations', {
    method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
      create('list', 'supplies', { title: 'Supplies', defaults: { ...defaultSettings, statuses: ['next'] } }),
      create('item', 'printer', { title: 'Printer paper specification', originalText: original, description: 'Tray holds 250 sheets.', listId: 'supplies', referenceLinks: ['https://example.com/manual'], plannedDay: '2026-10-03', dueDate: '2020-01-01' }),
      create('item', 'action', { title: 'Buy paper', status: 'next' })
    ] })
  });
  assert.equal(response.status, 200, await response.text());
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  const confirmed = () => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  const rows = () => page.locator('#items article').evaluateAll(items => items.map(item => item.dataset.id).sort());
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor();
  await page.locator('#view').selectOption('all'); await confirmed();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Edit Printer paper specification', exact: true }).click();
  await page.locator('#edit [name=status]').selectOption('reference');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.deepEqual(await rows(), ['action']);
  await page.locator('#statusFilter').selectOption('reference');
  assert.deepEqual(await rows(), ['printer']);
  assert.match(await page.locator('#items').innerText(), /pending/);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=3')).transact('alice')).draft.navigation?.work.status === 'reference');
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.deepEqual(await rows(), ['printer']);
  assert.equal(await page.getByRole('button', { name: 'Clarify Printer paper specification', exact: true, includeHidden: true }).count(), 1);
  for (const name of ['Complete', 'Brief']) assert.equal(await page.getByRole('button', { name: `${name} Printer paper specification`, exact: true, includeHidden: true }).count(), 0);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'Edit Printer paper specification', exact: true }).focus();
    if (process.env.REFERENCE_SCREENSHOTS) {
      await mkdir(process.env.REFERENCE_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.REFERENCE_SCREENSHOTS}/reference-${width}.png`, fullPage: true });
    }
  }
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#original').textContent(), original);
  await page.locator('#edit [name=description]').fill('Tray holds 250 sheets. Use plain paper.');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed();
  const item = () => documents.find(doc => doc.UserID === 'alice' && doc.id === 'record:item:printer').record;
  assert.equal(item().status, 'reference'); assert.equal(item().nextAction, false);
  assert.equal(item().originalText, original); assert.equal(item().description, 'Tray holds 250 sheets. Use plain paper.');
  assert.deepEqual(item().referenceLinks, ['https://example.com/manual']);
  assert.equal(item().listId, 'supplies'); assert.equal(item().dueDate, '2020-01-01');
  await page.locator('#statusFilter').selectOption('@all');
  await page.locator('#view').selectOption('inbox'); assert.deepEqual(await rows(), []);
  await page.locator('#view').selectOption('day'); await page.locator('#day').fill('2026-10-03'); assert.deepEqual(await rows(), []);
  await page.locator('#view').selectOption('all'); await page.locator('#statusFilter').selectOption('next'); assert.deepEqual(await rows(), ['action']);
  await clickControl(page.locator('#openReviews'));
  for (const kind of ['Daily', 'Weekly']) {
    await page.locator(`#start${kind}`).click();
    await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 1'));
    await confirmed();
    assert.equal(await page.locator('#reviewTitle').textContent(), 'Buy paper');
  }
  await page.locator('#closeReviews').click();
  await showView(page, 'lists'); await page.locator('#view').selectOption('supplies');
  assert.deepEqual(await rows(), []);
  await page.locator('#statusFilter').selectOption('reference'); assert.deepEqual(await rows(), ['printer']);
  // Reclassification remains an ordinary edit and state undo can restore reference.
  await page.getByRole('button', { name: 'Edit Printer paper specification', exact: true }).click();
  await page.locator('#edit [name=status]').selectOption('next');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' }); await confirmed();
  await page.locator('#statusFilter').selectOption('next');
  await clickControl(page.getByRole('button', { name: 'Undo state change Printer paper specification', exact: true, includeHidden: true }));
  await page.locator('#items article[data-id=printer]').waitFor({ state: 'detached' }); await confirmed();
  assert.equal(item().status, 'reference'); assert.equal(item().originalText, original);
});
