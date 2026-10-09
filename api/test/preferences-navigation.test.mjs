import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { openPreference, openPreferences, showView } from './navigation-helper.mjs';

async function setup(t, user = 'alice') {
  documents.length = 0;
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  return { page, context, server, setUser(value) { user = value; } };
}

test('Preferences routes expose only live categories with route, focus, Back and responsive contracts', { timeout: 90000 }, async t => {
  const { page, context, server } = await setup(t);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.locator('#captureText').fill('Queued before Preferences');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.locator('#captureText').fill('Draft kept through Preferences');
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return local.queue.length === 1 && local.draft.capture.text === 'Draft kept through Preferences';
  });
  const before = await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'));
  await openPreferences(page);
  assert.equal(await page.title(), 'Preferences · Personal');
  assert.deepEqual(await page.locator('#preferencesCategories > li > a > span:first-child').allTextContents(), ['Appearance', 'Process', 'Task options']);
  assert.equal(await page.locator('#preferencesView').getByText(/Capture|Organize|Plan|Do|Review/, { exact: true }).count(), 0);
  assert.equal(await page.locator('#preferencesView').getByText(/Install|update|reset/i).count(), 0);
  assert.deepEqual(await page.locator('#preferencesCategories .menu-row-value').allTextContents(), ['Dark · Browser', '12 actions · Browser', 'Account']);

  await openPreference(page, 'appearance');
  assert.equal(new URL(page.url()).hash, '#preferences/appearance');
  assert.equal(await page.title(), 'Appearance · Personal');
  assert.equal(await page.locator('h1:visible').count(), 1);
  assert.equal(await page.locator('#preferencesAppearanceHeading').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('#preference-appearance').getAttribute('aria-current'), 'page');
  await page.locator('[data-appearance]').selectOption('light');
  assert.equal(await page.locator('#preference-appearance-summary').textContent(), 'Light · Browser');

  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1024, 768], [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    await page.setViewportSize({ width, height });
    assert.equal(new URL(page.url()).hash, '#preferences/appearance');
    assert.equal(await page.locator('#preferencesAppearanceHeading').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#preference-appearance').getAttribute('aria-current'), 'page');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px has no horizontal overflow`);
    assert.equal(await page.locator('#preferencesNav').isVisible(), width >= 1024);
    if (width >= 1024) assert.equal(Math.round((await page.locator('#preferencesNav').boundingBox()).width), 280);
    assert.ok(await page.locator('.preferences-detail:visible .menu-page-bar').evaluate(element => element.getBoundingClientRect().height >= 48));
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  const afterResize = await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'));
  assert.deepEqual(afterResize.queue, before.queue);
  assert.equal(afterResize.draft.capture.text, before.draft.capture.text);
  await page.locator('.preferences-detail:visible .preference-back').click();
  await page.waitForFunction(() => location.hash === '#preferences' && document.activeElement?.id === 'preference-appearance');

  await page.goto(server.url + '#preferences/process'); await page.locator('#preferencesProcessHeading').waitFor();
  assert.equal(await page.locator('#preferencesProcessHeading').evaluate(element => element === document.activeElement), true);
  await page.locator('.preferences-detail:visible .preference-back').click();
  await page.waitForFunction(() => location.hash === '#capture');
  await page.goto(server.url + '#preferences'); await page.locator('#preferencesHeading').waitFor();
  assert.equal(new URL(page.url()).hash, '#preferences');
  await context.setOffline(false);
  await page.goto(server.url + '#preferences/capture'); await page.waitForFunction(() => location.hash === '#capture');
  assert.equal(await page.locator('#captureText').isVisible(), true);
});

test('Task options use account draft storage while browser preferences stay browser-scoped', { timeout: 90000 }, async t => {
  const { page, context, setUser } = await setup(t);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await openPreference(page, 'appearance');
  await page.locator('[data-appearance]').selectOption('light');
  await openPreference(page, 'task-options');
  await page.locator('#defaultsForm [name=contexts]').fill('@Home\n@Draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).preferenceDraft?.defaults?.values.contexts === '@Home\n@Draft');
  await page.reload(); await page.locator('#preferencesTaskOptionsHeading').waitFor();
  assert.equal(await page.locator('#defaultsForm [name=contexts]').inputValue(), '@Home\n@Draft');
  await context.setOffline(true);
  await page.locator('#defaultsForm [type=submit]').click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return local.queue.length === 1 && local.preferenceDraft?.defaults === null;
  });
  assert.equal(new URL(page.url()).hash, '#preferences/task-options');
  await page.locator('[data-appearance]').count();
  await context.setOffline(false);
  setUser('bob');
  await page.locator('#sync').evaluate(button => button.click());
  await page.waitForFunction(() => location.hash === '#capture' && !document.querySelector('#workspace').hidden);
  assert.equal(await page.locator('#defaultsForm [name=contexts]').inputValue(), '');
  await openPreference(page, 'appearance');
  assert.equal(await page.locator('[data-appearance]').inputValue(), 'light');
  assert.equal((await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('bob'))).queue.length, 0);
  await showView(page, 'capture');
});
