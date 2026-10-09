import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

test('progressive controls keep capture and editor actions reachable without exposing advanced fields', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const shots = process.env.PROGRESSIVE_SCREENSHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await page.waitForFunction(() => document.querySelector('#connectionLabel').textContent === 'Saved to cloud');
  for (const width of [320, 400, 767, 768, 936, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => scrollTo(0, 0));
    assert.notEqual(new URL(page.url()).hash, '#menu');
    assert.equal(await page.locator('#appMenu').isVisible(), true);
    assert.equal(await page.locator('#export').isVisible(), false);
    for (const selector of ['#captureText', '#capture button[type=submit]:visible', '#openReviews']) {
      const rect = await page.locator(selector).boundingBox();
      assert.ok(rect.y >= 0 && rect.y + rect.height <= 900, `${selector} reachable at ${width}: ${JSON.stringify(rect)}`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (shots) await page.screenshot({ path: `${shots}/capture-${width}.png` });
  }
  await page.locator('#appMenu').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#menu' && document.activeElement.id === 'menuHeading');
  await page.setViewportSize({ width: 767, height: 900 });
  assert.equal(new URL(page.url()).hash, '#menu', 'resizing preserves the Menu route');
  await page.locator('#sync').focus(); await page.keyboard.press('Escape');
  assert.equal(new URL(page.url()).hash, '#menu', 'Escape does not close a routed page');
  await page.setViewportSize({ width: 768, height: 900 });
  assert.equal(new URL(page.url()).hash, '#menu', 'crossing the layout breakpoint preserves the route');
  await page.locator('#menuBack').click();
  await page.waitForFunction(() => location.hash === '#capture' && document.activeElement.id === 'appMenu');

  await context.setOffline(true);
  await page.locator('#captureText').fill('Prepare the room');
  await page.locator('#captureOptions > summary').click();
  assert.equal(await page.locator('#capture button[type=submit]').count(), 1, 'capture has one Save button with options open');
  assert.equal(await page.locator('#capture [name=listId]').isVisible(), true);
  assert.equal(await page.locator('#capture [name=projectId], #capture [name=areas]').count(), 0);
  assert.equal(await page.locator('#captureOptions > summary').innerText(), 'Context or list');
  assert.deepEqual(await page.locator('#captureOptions > label').evaluateAll(labels => labels.map(label => label.firstChild.textContent.trim())), ['Contexts', 'List', 'Or create a list']);
  assert.equal(await page.locator('#capture [name=body]').count(), 0);
  assert.equal(await page.locator('#capture [name=contexts]').isVisible(), true);
  for (const name of ['dueLocal', 'dueDate', 'waitingOn', 'energy', 'timeRequired']) assert.equal(await page.locator(`#capture [name=${name}]`).count(), 0);
  await page.locator('#capture [name=newList]').fill('Home');
  assert.equal(await page.locator('#capture [name=status]').count(), 0);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.capture.newList === 'Home');
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'Prepare the room');
  assert.equal(await page.locator('#capture [name=newList]').inputValue(), 'Home');
  const savedCapture = await page.evaluate(async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.capture);
  assert.deepEqual(Object.keys(savedCapture).sort(), ['contexts', 'listId', 'newList', 'text']);
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await showView(page, 'work'); await page.locator('#view').selectOption('all');
  await page.getByRole('button', { name: 'Edit Prepare the room', exact: true }).click();
  assert.equal(await page.locator('#edit [name=status]').isVisible(), true);
  assert.equal(await page.locator('#edit [name=dueLocal]').isVisible(), false);
  await page.locator('#edit [name=status]').selectOption('waiting');
  assert.equal(await page.locator('#edit [name=waitingOn]').isVisible(), true);
  await page.locator('#edit [name=dueDate]').fill('2026-12-01');
  await page.locator('#edit [type=submit]').click();
  assert.match(await page.locator('#editError').innerText(), /Waiting needs/);
  await page.locator('#edit [name=waitingOn]').fill('Alex');
  await page.locator('#edit .task-metadata > summary').click();
  // Native validity errors inside a closed disclosure must be focusable.
  await page.locator('#edit [name=plannedDay]').evaluate(el => el.setCustomValidity('Check this date'));
  await page.locator('#edit .task-dates > summary').click();
  await page.locator('#edit [type=submit]').click();
  assert.equal(await page.locator('#edit .task-dates').evaluate(el => el.open), true);
  await page.locator('#edit [name=plannedDay]').evaluate(el => el.setCustomValidity(''));
  for (const [width, height] of [[320, 600], [400, 900], [767, 900], [768, 900], [936, 900], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    for (const bottom of [false, true]) {
      await page.locator('#editor .edit-scroll').evaluate((el, bottom) => { el.scrollTop = bottom ? el.scrollHeight : 0; }, bottom);
      for (const selector of ['#edit [type=submit]', '#cancelEdit']) {
        const rect = await page.locator(selector).boundingBox();
        assert.ok(rect.y >= 0 && rect.y + rect.height <= height && rect.height >= 44, `${selector} at ${width}x${height}: ${JSON.stringify(rect)}`);
      }
    }
    if (shots) await page.screenshot({ path: `${shots}/editor-${width}.png` });
  }
  await page.locator('#edit [type=submit]').click(); await page.locator('#editor').waitFor({ state: 'hidden' });
  // Projected state includes the offline edit and retains the collapsed deadline.
  const item = await page.evaluate(async () => {
    const { transact, projected } = await import('/inbox-store.js?v=9');
    return Object.values(projected(await transact('alice'))).find(record => record.type === 'item');
  });
  assert.equal(item.status, 'waiting'); assert.equal(item.waitingOn, 'Alex'); assert.equal(item.dueDate, '2026-12-01');
  assert.deepEqual(errors, []);
});
