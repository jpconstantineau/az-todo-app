import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { openMenu, openUtility } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;

async function setup(t, url = '') {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + url); await page.locator('#workspace').waitFor();
  return { server, context, page, errors };
}

test('clear-device copy leads with data loss and preserves responsive accessible navigation', async t => {
  const { page, context, errors } = await setup(t);
  await openUtility(page, 'data-recovery');
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  const row = page.locator('#utility-restore-from-cloud');
  assert.equal(await row.locator('span').first().textContent(), 'Clear device data & reload cloud copy');
  assert.equal(await row.getAttribute('aria-label'), null);
  assert.equal(await page.getByRole('link', { name: 'Clear device data & reload cloud copy', exact: true }).count(), 1);
  assert.ok((await row.boundingBox()).height >= 48, 'the wrapped row keeps its touch target');
  assert.equal(await row.locator('[aria-hidden="true"]').isVisible(), true);
  assert.ok(await row.evaluate(element => element.scrollWidth <= element.clientWidth), 'the row does not clip horizontally');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the page does not scroll horizontally');

  await row.click();
  await page.waitForFunction(() => location.hash === '#data-recovery/restore-from-cloud' && document.activeElement?.id === 'deviceResetHeading');
  assert.equal(await page.locator('#deviceResetHeading').textContent(), 'Clear device data & reload cloud copy');
  assert.equal(await page.title(), 'Clear device data & reload cloud copy · Personal');
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#data-recovery' && document.activeElement?.id === 'utility-restore-from-cloud');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

  await row.click();
  await page.waitForFunction(() => location.hash === '#data-recovery/restore-from-cloud' && document.activeElement?.id === 'deviceResetHeading');
  await page.getByRole('button', { name: 'Review device data to clear', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#data-recovery/restore-from-cloud/review' && document.activeElement?.id === 'resetReviewHeading');
  assert.equal(await page.locator('#resetReviewHeading').textContent(), 'Review device data to clear');
  assert.equal(await page.title(), 'Review device data to clear · Personal');
  const confirm = page.getByRole('button', { name: 'Clear device data and reload', exact: true });
  assert.equal(await confirm.count(), 1);
  await context.setOffline(true);
  await confirm.click();
  await page.waitForFunction(() => document.querySelector('#resetReviewStatus').textContent.includes('Sign in online'));
  assert.equal(await page.locator('#resetReviewStatus').textContent(), 'Device database was not cleared: Sign in online before clearing device data and reloading the cloud copy.');
  assert.deepEqual(errors, []);
});

test('utility pages route directly, preserve sibling history and reflow from compact through 4K', { timeout: 60000 }, async t => {
  const { page, context, server, errors } = await setup(t, '#app-device/install');
  await page.waitForFunction(() => location.hash === '#app-device/install' && document.activeElement?.id === 'installHeading');
  assert.equal(await page.locator('#utilityView dialog').count(), 0);
  assert.equal(await page.locator('#utilityView h1:visible').count(), 1);
  await page.reload(); await page.waitForFunction(() => location.hash === '#app-device/install' && document.activeElement?.id === 'installHeading');
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true); await page.reload();
  await page.waitForFunction(() => location.hash === '#app-device/install' && document.activeElement?.id === 'installHeading');
  await context.setOffline(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#utility-updates').click();
  await page.waitForFunction(() => location.hash === '#app-device/updates' && document.activeElement?.id === 'updatesHeading');
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#app-device' && document.activeElement?.id === 'utility-updates');
  await page.goForward();
  await page.waitForFunction(() => location.hash === '#app-device/updates' && document.activeElement?.id === 'updatesHeading');

  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await openMenu(page); await page.locator('#openAppDevice').click();
  await page.locator('#utility-install').click();
  await page.waitForFunction(() => location.hash === '#app-device/install');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#utility-updates').click();
  await page.waitForFunction(() => location.hash === '#app-device/updates' && document.activeElement?.id === 'updatesHeading');
  assert.equal(await page.locator('#utility-updates').getAttribute('aria-current'), 'page');
  await page.locator('#utility-updates').focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.activeElement?.id === 'updatesHeading');

  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1024, 900], [1600, 1000], [3840, 2160]]) {
    await page.setViewportSize({ width, height });
    assert.equal(new URL(page.url()).hash, '#app-device/updates');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px has no horizontal page scroll`);
    if (width >= 1024) {
      assert.equal(Math.round((await page.locator('#utilityMaster').boundingBox()).width), 280);
      assert.ok((await page.locator('#appDeviceUpdates').boundingBox()).width <= 760);
    } else assert.equal(await page.locator('#utilityMaster').isVisible(), false);
  }
  await page.setViewportSize({ width: 320, height: 700 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#app-device' && document.activeElement?.id === 'utility-install');
  await page.goto(server.url + '#app-device/not-a-page');
  await page.waitForFunction(() => location.hash === '#capture');
  await context.setOffline(true);
  await page.goto(server.url + '#data-recovery/restore-from-cloud/review');
  await page.waitForFunction(() => location.hash === '#data-recovery/restore-from-cloud/review' && document.querySelectorAll('#resetImpact h2').length === 4);
  assert.match(await page.locator('#resetImpact').textContent(), /Current account local drafts \(0\)/);
  await context.setOffline(false);
  assert.deepEqual(errors, []);
});

test('clear-device review inventories every account privately and refreshes stale impact before deletion', { timeout: 60000 }, async t => {
  const { page, errors } = await setup(t);
  await page.locator('#captureText').fill('Current private draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=16')).transact('alice')).draft.capture.text === 'Current private draft');
  await page.evaluate(async () => {
    const { transact, enqueue } = await import('/inbox-store.js?v=16');
    await transact('alice', local => enqueue(local, 'alice', [{ type: 'item', id: 'pending', action: 'create', expectedVersion: 0,
      fields: { title: 'Current pending title', workspaceId: 'personal', collectionRefs: [] } }]));
    await transact('bob-secret-identity', local => {
      local.draft.capture = { text: 'Inactive secret draft' };
      enqueue(local, 'bob-secret-identity', [{ type: 'item', id: 'secret', action: 'create', expectedVersion: 0,
        fields: { title: 'Inactive secret title', workspaceId: 'personal', collectionRefs: [] } }]);
    });
  });
  await openUtility(page, 'data-recovery/restore-from-cloud');
  await page.locator('#resetDeviceData').click();
  await page.waitForFunction(() => location.hash === '#data-recovery/restore-from-cloud/review');
  const impact = await page.locator('#resetImpact').textContent();
  assert.match(impact, /Pending save: item “Current pending title”/);
  assert.match(impact, /Current account local drafts \(1\).*Personal · Capture/s);
  assert.match(impact, /1 inactive account: 1 pending or failed operation and 1 local draft or recovery entry/);
  assert.doesNotMatch(impact, /bob-secret|Inactive secret/);

  await page.evaluate(async () => {
    const { transact } = await import('/inbox-store.js?v=16');
    await transact('alice', local => { local.draft.capture.text = 'Changed after review with the same draft count'; });
  });
  await page.locator('#confirmResetDeviceData').click();
  await page.waitForFunction(() => document.querySelector('#resetReviewStatus').textContent.includes('Device data changed after this review'));
  assert.equal((await page.evaluate(async () => (await (await import('/inbox-store.js?v=16')).transact('alice')))).draft.capture.text, 'Changed after review with the same draft count');

  await page.evaluate(async () => {
    const { transact, enqueue } = await import('/inbox-store.js?v=16');
    await transact('alice', local => enqueue(local, 'alice', [{ type: 'item', id: 'later', action: 'create', expectedVersion: 0,
      fields: { title: 'Changed after review', workspaceId: 'personal', collectionRefs: [] } }]));
  });
  await page.locator('#confirmResetDeviceData').click();
  await page.waitForFunction(() => document.querySelector('#resetReviewStatus').textContent.includes('Device data changed after this review'));
  assert.match(await page.locator('#resetImpact').textContent(), /Changed after review/);
  assert.equal(new URL(page.url()).hash, '#data-recovery/restore-from-cloud/review');
  await page.locator('#cancelResetReview').click();
  await page.waitForFunction(() => location.hash === '#data-recovery/restore-from-cloud');
  assert.equal((await page.evaluate(async () => (await (await import('/inbox-store.js?v=16')).transact('alice')))).queue.length, 2);
  assert.deepEqual(errors, []);
});
