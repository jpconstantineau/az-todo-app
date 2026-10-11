import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { showView, clickControl } from './navigation-helper.mjs';

async function capture(page, title) {
  await showView(page, 'capture');
  await page.locator('#captureText').fill(title);
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
}

async function assertFits(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator('#items').evaluate(element => element.scrollWidth <= element.clientWidth));
}

test('Process feedback distinguishes an empty Inbox from filtered work and keeps device status at page level', { timeout: 60000 }, async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await showView(page, 'work');

  assert.equal(await page.locator('#items').textContent(), 'Inbox is empty. Use Capture to add work, or choose another View to see saved work.');
  assert.equal(await page.locator('#clarifyInbox').isVisible(), false);
  await assertFits(page);
  await page.setViewportSize({ width: 390, height: 844 }); await assertFits(page);

  await page.locator('#clarifyInbox').evaluate(button => button.click());
  await page.locator('#error').waitFor();
  assert.match(await page.locator('#error').textContent(), /No unprocessed captures/);
  assert.equal(await page.locator('#connectionLabel').textContent(), 'Saved on this device');
  assert.equal(await page.locator('#saveStatus').getAttribute('data-state'), 'confirmed');

  await capture(page, 'Sort the paper inbox'); await showView(page, 'work');
  assert.equal(await page.locator('#clarifyInbox').isVisible(), true);
  assert.equal(await page.locator('#items .record-state').textContent(), 'inbox');
  assert.equal(await page.locator('#items .record-state').getAttribute('data-pending'), 'false');

  await page.locator('#statusFilter').selectOption('next');
  assert.equal(await page.locator('#items').textContent(), 'No Inbox items match the current Status filter. Reset Status, or choose another View.');
  assert.equal(await page.locator('#clarifyInbox').isVisible(), true);
  await assertFits(page);
  await page.setViewportSize({ width: 1440, height: 900 }); await assertFits(page);

  await page.locator('#statusFilter').selectOption('');
  await clickControl(page.locator('#clarifyInbox'));
  await page.getByRole('button', { name: 'Action', exact: true }).click();
  await page.locator('#clarifySave').click();
  await page.waitForFunction(() => document.querySelector('#clarifyQuestion').textContent === 'Session summary');
  assert.equal(await page.locator('#clarifyInbox').isVisible(), false);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'itemsHeading');
  assert.equal(await page.locator('#items').textContent(), 'Inbox is empty. Use Capture to add work, or choose another View to see saved work.');
  await page.locator('#view').selectOption('all');
  assert.equal(await page.locator('#items .record-state').textContent(), 'next');
  assert.equal(await page.locator('#items .record-state').getAttribute('data-pending'), 'false');
  assert.deepEqual(errors, []);
});

test('Process rows retain actionable cloud pending and failed save feedback', { timeout: 60000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

  await context.setOffline(true); await capture(page, 'Keep this save visible'); await showView(page, 'work');
  assert.equal(await page.locator('#items .record-state').textContent(), 'inbox · Saved on device — pending');
  assert.equal(await page.locator('#items .record-state').getAttribute('data-pending'), 'true');

  await page.route('**/api/v1/operations', route => route.fulfill({ status: 400, contentType: 'application/json',
    body: JSON.stringify({ apiVersion: 1, error: 'invalid_request', message: 'Needs correction.' }) }));
  await context.setOffline(false); await clickControl(page.locator('#sync'));
  await page.locator('#failure').waitFor();
  assert.equal(await page.locator('#items .record-state').textContent(), 'inbox · Failed — needs attention');
  assert.equal(await page.locator('#items .record-state').getAttribute('data-pending'), 'true');
  await assertFits(page);
});
