import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { openMenu, showView } from './navigation-helper.mjs';

test('routed Menu preserves work, history, focus and responsive row behavior', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#connectionLabel').textContent === 'Saved to cloud');
  await page.locator('#captureText').fill('Draft kept through Menu');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.capture.text === 'Draft kept through Menu');
  await showView(page, 'work');
  await page.evaluate(() => { document.body.style.minHeight = '2500px'; scrollTo(0, 600); });
  await page.waitForFunction(() => scrollY === 600);

  await page.locator('#appMenu').evaluate(element => element.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#menu' && document.activeElement.id === 'menuHeading');
  assert.equal(new URL(page.url()).hash, '#menu');
  assert.equal(await page.title(), 'Menu · Personal');
  assert.equal(await page.locator('#menuHeading').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('.workspace-nav').isVisible(), false);
  assert.equal(await page.locator('.inbox-grid').isVisible(), false);
  assert.equal(await page.locator('#export').isVisible(), false, 'export controls are not embedded in Menu');
  assert.equal(await page.locator('#menuWorkspaceValue').textContent(), 'Personal');
  assert.equal(await page.locator('#menuSyncState').textContent(), 'Saved');
  assert.deepEqual(await page.locator('.menu-group > h2').allTextContents(), ['Workspace', 'Settings', 'Support', 'Account']);
  for (const [name, path] of [['Shared lists opens in a new tab', '/shared.html'], ['Help opens in a new tab', '/help.html']]) {
    const opened = page.waitForEvent('popup');
    await page.getByRole('link', { name, exact: true }).click();
    const utility = await opened; await utility.waitForLoadState();
    assert.equal(new URL(utility.url()).pathname, path); await utility.close();
    assert.equal(new URL(page.url()).hash, '#menu');
    assert.equal(await page.locator('#captureText').inputValue(), 'Draft kept through Menu');
  }
  await page.locator('#openAppDevice').click();
  await page.waitForFunction(() => location.hash === '#app-device' && document.activeElement.id === 'utilityHubHeading');
  await page.locator('#utility-install').click();
  await page.waitForFunction(() => location.hash === '#app-device/install' && document.activeElement.id === 'installHeading');
  await page.locator('#appDeviceInstall .utility-back').click();
  await page.waitForFunction(() => location.hash === '#app-device' && document.activeElement.id === 'utility-install');
  await page.locator('#utilityHubBack').click();
  await page.waitForFunction(() => location.hash === '#menu');
  assert.equal(await page.locator('#openAppDevice').evaluate(element => element === document.activeElement), true);

  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1024, 768], [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    await page.setViewportSize({ width, height });
    assert.equal(new URL(page.url()).hash, '#menu');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} px has no horizontal overflow`);
    const rows = await page.locator('#menuView .menu-row').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    assert.ok(rows.every(rowHeight => rowHeight >= 48), `${width} px rows remain 48 px targets`);
    const menuWidth = (await page.locator('.menu-master').boundingBox()).width;
    if (width >= 1024) assert.ok(menuWidth >= 280 && menuWidth <= 320, `${width} px uses the focused desktop column`);
    else assert.ok(menuWidth <= 720, `${width} px keeps the single column capped`);
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200% text does not overflow horizontally');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.emulateMedia({ forcedColors: 'active' });
  assert.equal(await page.locator('#appMenu').getAttribute('aria-current'), 'page');
  await page.emulateMedia({ forcedColors: 'none' });

  await page.goBack();
  await page.waitForFunction(() => location.hash === '#work');
  await page.waitForFunction(() => document.activeElement.id === 'appMenu');
  assert.equal(await page.evaluate(() => scrollY), 600);
  assert.equal(await page.locator('#captureText').inputValue(), 'Draft kept through Menu');
  await page.goForward();
  await page.waitForFunction(() => location.hash === '#menu' && document.activeElement.id === 'openAppDevice');
  await page.locator('#menuBack').click();
  await page.waitForFunction(() => location.hash === '#work' && document.activeElement.id === 'appMenu');
  assert.equal(await page.evaluate(() => scrollY), 600);

  await context.setOffline(true);
  await openMenu(page);
  await page.waitForFunction(() => document.querySelector('#menuSyncState').textContent === 'Offline');
  await page.reload();
  await page.waitForFunction(() => location.hash === '#capture');
  assert.equal(await page.locator('#captureText').inputValue(), 'Draft kept through Menu');
  assert.deepEqual(errors, []);
});

test('direct Menu links safely normalize to Capture', async t => {
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(server.url + '#menu'); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => location.hash === '#capture');
  assert.equal(await page.locator('#captureText').isVisible(), true);
  assert.equal(await page.title(), 'Capture · Personal');
});
