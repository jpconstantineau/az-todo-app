import { clickControl } from './navigation-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { mkdir } from 'node:fs/promises';
import { reviewHistory } from '../../html/reviews.js';
import { currentCreate } from './current-record.mjs';

const records = () => documents.filter(doc => doc.kind === 'record').map(doc => doc.record);
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const op = mutations => ({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations });
const create = currentCreate;

test('reviews resume offline and across devices, allow retained unknowns and undo, and hide switched accounts', { timeout: 90000 }, async t => {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await page.locator('#captureText').fill('Milk\nInsurance'); await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#items article').length === 2); await confirmed(page);
  await clickControl(page.locator('#openReviews')); await page.locator('#startDaily').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 0'));
  assert.match(await page.locator('#reviewDetails').textContent(), /empty/); await confirmed(page);
  await context.setOffline(true);
  await page.locator('#startWeekly').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 2'));
  await page.locator('#reviewRetain').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 2'));
  assert.match(await page.locator('#reviewProgress').textContent(), /pending/);
  await page.locator('#reviewDefer').fill('2026-10-08');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=6')).transact('alice')).draft.review?.deferUntil === '2026-10-08');
  await page.reload(); await page.locator('#workspace').waitFor(); await clickControl(page.locator('#openReviews'));
  assert.match(await page.locator('#reviewProgress').textContent(), /1 of 2/); assert.equal(await page.locator('#reviewDefer').inputValue(), '2026-10-08');
  await page.locator('#reviewDeferSave').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('2 of 2'));
  await page.locator('#reviewRecord').selectOption('1'); await page.locator('#reviewUndo').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 2'));
  await page.locator('#reviewDrop').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('2 of 2'));
  await page.locator('#closeReviews').click(); await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  const session = records().find(r => r.type === 'review' && r.reviewKind === 'weekly');
  assert.deepEqual(reviewHistory(session, Object.fromEntries(records().map(r => [`${r.type}:${r.id}`, r]))).map(d => d.choice), ['retain', 'defer', 'undo', 'drop']);
  const retained = records().find(r => r.id === session.included[0].id);
  assert.equal(retained.status, 'inbox'); assert.equal(retained.startDate ?? null, null);
  const second = await browser.newContext(); const other = await second.newPage();
  await other.goto(server.url); await other.locator('#workspace').waitFor(); await confirmed(other);
  await clickControl(other.locator('#openReviews')); await other.locator('#reviewSessions').selectOption(session.id);
  assert.match(await other.locator('#reviewProgress').textContent(), /2 of 2/);
  await other.locator('#reviewRecord').selectOption('1'); await other.locator('#reviewUndo').click();
  await other.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 2')); await confirmed(other);
  assert.equal(records().find(r => r.id === session.included[1].id).status, 'inbox');
  for (const width of [320, 390, 768, 1440, 2560]) {
    await other.setViewportSize({ width, height: 900 });
    assert.ok(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await other.locator('#reviews').evaluate(el => el.scrollWidth <= el.clientWidth));
  }
  if (process.env.REVIEW_SCREENSHOTS) {
    await mkdir(process.env.REVIEW_SCREENSHOTS, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await other.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await other.setViewportSize({ width: 390, height: 844 });
      await other.evaluate(() => scrollTo(0, 0));
      await other.screenshot({ path: `${process.env.REVIEW_SCREENSHOTS}/review-${theme}-390.png`, fullPage: true });
    }
  }
  await other.locator('#closeReviews').click();
  user = 'bob'; await clickControl(other.locator('#sync')); await other.waitForFunction(() => document.querySelector('#workspace').hidden === false && document.querySelectorAll('#items article').length === 0);
  await clickControl(other.locator('#openReviews')); assert.equal(await other.locator('#reviewSessions option').count(), 1);
  assert.equal(await other.locator('#reviewHistory').textContent(), ''); assert.deepEqual(errors, []);
});

test('review cues include projects and waiting work; competing devices and deleted records recover visibly', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const post = async mutations => { const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(op(mutations)) }); assert.equal(response.status, 200); return response.json(); };
  await post([
    create('item', 'next', { title: 'Call agent', status: 'next' }),
    create('item', 'waiting', { title: 'Await policy', status: 'waiting', waitingOn: 'Agent quote', reviewDate: '2020-01-01' }),
    create('item', 'future', { title: 'Later choice', status: 'deferred', startDate: '9999-01-01' }),
    create('item', 'inbox', { title: 'Unsorted idea' }),
    create('item', 'completed', { title: 'Finished work', status: 'completed' }),
    create('item', 'dropped', { title: 'Dropped work', status: 'dropped' }),
    create('project', 'project', { title: 'Insurance', outcome: 'Have appropriate coverage' })
  ]);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const first = await browser.newContext(), second = await browser.newContext();
  const page = await first.newPage(), other = await second.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await clickControl(page.locator('#openReviews')); await page.locator('#startDaily').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 2')); await confirmed(page);
  let session = records().find(r => r.type === 'review');
  assert.deepEqual(session.included.map(r => r.id).sort(), ['next', 'waiting']);
  await page.locator('#startWeekly').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 5')); await confirmed(page);
  session = records().find(r => r.type === 'review' && r.reviewKind === 'weekly');
  const index = id => String(session.included.findIndex(r => r.id === id));
  await other.goto(server.url); await other.locator('#workspace').waitFor(); await confirmed(other);
  await clickControl(other.locator('#openReviews')); await other.locator('#reviewSessions').selectOption(session.id);
  await second.setOffline(true);
  await page.locator('#reviewRecord').selectOption(index('next')); await other.locator('#reviewRecord').selectOption(index('next'));
  await page.locator('#reviewRetain').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 5')); await confirmed(page);
  await other.locator('#reviewDrop').click(); await other.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 5'));
  await other.locator('#closeReviews').click(); await second.setOffline(false); await clickControl(other.locator('#sync')); await other.locator('#failure').waitFor();
  assert.equal(await other.locator('#resolve').isVisible(), false);
  assert.equal(records().find(r => r.id === 'next' && r.type === 'item').status, 'next');
  other.once('dialog', dialog => dialog.accept()); await other.locator('#discard').click(); await other.locator('#failure').waitFor({ state: 'hidden' }); await confirmed(other);
  const doomed = records().find(r => r.id === 'inbox' && r.type === 'item');
  await post([{ type: 'item', id: doomed.id, action: 'delete', expectedVersion: doomed.version }]);
  await clickControl(other.locator('#sync'));
  await waitForBrowser(other, async () => (await (await import('/inbox-store.js?v=6')).transact('alice')).records['item:inbox']?.deleted);
  await clickControl(other.locator('#openReviews')); await other.locator('#reviewRecord').selectOption(index('inbox'));
  assert.match(await other.locator('#reviewDetails').textContent(), /deleted or is unavailable/);
  await other.locator('#reviewUnavailable').click(); await other.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('2 of 5')); await confirmed(other);
  await other.locator('#reviewRecord').selectOption(index('project'));
  assert.match(await other.locator('#reviewDetails').textContent(), /Have appropriate coverage/);
  assert.equal(await other.locator('#reviewDrop').isDisabled(), true);
  await other.locator('#reviewRetain').focus(); await other.keyboard.press('Enter');
  await other.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('3 of 5')); await confirmed(other);
  assert.equal(records().find(r => r.type === 'review' && r.id === session.id).decisionCount, 3);
});
