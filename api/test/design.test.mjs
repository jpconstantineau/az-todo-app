import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';

const baseline = process.env.DESIGN_BASELINE === '1';
const screenshots = process.env.DESIGN_SCREENSHOTS;
test('design: responsive populated workspaces and appearance', { timeout: 120000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: true });
  t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  t.after(() => browser.close());
  const context = await browser.newContext({ colorScheme: 'dark', timezoneId: 'America/Regina' });
  const page = await context.newPage();
  await page.route('https://cdn.jsdelivr.net/npm/htmx.org@1.9.12', route => route.fulfill({
    contentType: 'text/javascript', path: fileURLToPath(new URL('../node_modules/htmx.org/dist/htmx.min.js', import.meta.url))
  }));
  async function post(path, data) {
    const response = await context.request.post(server.url + '/api/' + path, { form: data, headers: { origin: server.url } });
    assert.equal(response.status(), 200);
  }
  await post('lists/create', { title: 'Weekend plans', description: 'A little space for life outside work.' });
  const listId = documents.find(d => d.ObjectType === 'list').id;
  await post('lists/create', { title: 'Home & errands' });
  for (const [title, description, status] of [
    ['Plan a walk by the river', 'Check the weather and pick a trail for Saturday.', 'next'],
    ['Book the bike tune-up', 'Ask about brake pads and a spring service.', 'waiting'],
    ['Pick up groceries for dinner', 'Tomatoes, bread, olive oil, and something for dessert.', 'completed']
  ]) await post('items/create', { title, description, status, listId });
  if (screenshots) await mkdir(screenshots, { recursive: true });
  async function shot(name) {
    if (screenshots) await page.screenshot({ path: `${screenshots}/${baseline ? 'before' : 'after'}-${name}.png`, fullPage: true });
  }
  async function fits() {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
  }
  async function settled() {
    await page.locator('#quickAdd').waitFor();
    await page.waitForFunction(() => !document.querySelector('.htmx-request, .htmx-settling') && document.querySelector('#requestStatus').textContent === '');
  }
  await page.goto(server.url);
  await page.locator('#quickAdd').waitFor();
  await page.locator('#listSelect').selectOption(listId);
  await page.locator('#items article').first().waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (!baseline) {
      await page.reload();
      await settled();
      await page.locator('#listSelect').selectOption(listId);
      await page.locator('#items article').first().waitFor();
      assert.equal(await page.locator('#listNavigation').evaluate(el => el.open), width >= 768);
      const capture = await page.locator('#quickAdd [name=title]').boundingBox();
      assert.ok(capture.y + capture.height < 900, 'capture visible in initial viewport');
    }
    await shot(`workspace-${width}`);
    if (!baseline) await fits();
  }
  if (!baseline) {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator('#quickAdd details summary').click();
    await fits();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Save user defaults' }).waitFor();
    await fits();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.locator('#quickAdd details summary').click();
    await page.locator('#quickAdd [name=title]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#listSelect').evaluate(el => el.matches(':focus-visible')), true);
    assert.equal(await page.locator('#listSelect').evaluate(el => getComputedStyle(el).outlineWidth), '3px');
    await shot('workspace-keyboard-focus-320');
    await page.locator('[data-appearance]').selectOption('light');
    await page.reload();
    await settled();
    await page.locator('#listSelect').selectOption(listId);
    await page.locator('#items article').first().waitFor();
    assert.equal(await page.locator('[data-appearance]').inputValue(), 'light');
    await shot('workspace-light-320');
    await page.locator('[data-appearance]').selectOption('system');
  }
  await page.goto(server.url + '/inbox.html');
  await page.locator('#workspace').waitFor();
  await page.locator('#captureText').fill('Plan a walk by the river\nBook the bike tune-up\nPick up groceries for dinner');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '' && document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await shot(`inbox-${width}`);
    if (!baseline) await fits();
  }
  if (baseline) return;
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('#captureText').focus();
  await page.keyboard.press('Tab');
  assert.ok(await page.getByRole('button', { name: 'Save on device', exact: true }).evaluate(el => el.matches(':focus-visible')));
  assert.equal(await page.getByRole('button', { name: 'Save on device', exact: true }).evaluate(el => getComputedStyle(el).outlineWidth), '3px');
  await shot('inbox-keyboard-focus-390');
  await page.locator('#captureText').fill('A'.repeat(200));
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await page.setViewportSize({ width: 320, height: 900 });
  await fits();
  await page.getByRole('button', { name: 'Edit ' + 'A'.repeat(200), exact: true }).click();
  await fits();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();

  // Measure resolved semantic colors, not just literal token values.
  function luminance(rgb) {
    return rgb.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; })
      .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  }
  for (const theme of ['light', 'dark']) {
    await page.locator('[data-appearance]').selectOption(theme);
    await page.reload();
    await page.locator('#workspace').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.locator('[data-appearance]').inputValue(), theme);
    const colors = await page.evaluate(() => {
      const probe = document.createElement('span'); document.body.append(probe);
      const values = Object.fromEntries(['canvas', 'surface', 'surface-raised', 'ink', 'muted', 'link', 'focus', 'success', 'warning', 'error', 'control-border', 'primary', 'on-primary'].map(token => {
        probe.style.color = `var(--${token})`;
        return [token, getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number)];
      }));
      probe.remove(); return values;
    });
    let minimum = Infinity;
    for (const background of ['canvas', 'surface', 'surface-raised']) {
      for (const foreground of ['ink', 'muted', 'link', 'focus', 'success', 'warning', 'error', 'control-border']) {
        const [a, b] = [luminance(colors[foreground]), luminance(colors[background])].sort((a, b) => b - a);
        const ratio = (a + .05) / (b + .05);
        const threshold = ['focus', 'control-border'].includes(foreground) ? 3 : 4.5;
        assert.ok(ratio >= threshold, `${theme} ${foreground}/${background}: ${ratio.toFixed(2)} >= ${threshold}`);
        if (threshold === 4.5) minimum = Math.min(minimum, ratio);
      }
    }
    const [a, b] = [luminance(colors.primary), luminance(colors['on-primary'])].sort((a, b) => b - a);
    assert.ok((a + .05) / (b + .05) >= 4.5);
    console.log(`${theme} minimum text contrast: ${minimum.toFixed(2)}:1`);
    if (theme === 'light') await shot('inbox-light-320');
  }
  await page.locator('[data-appearance]').selectOption('system');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(247, 248, 250)');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
  await fits();
  await context.setOffline(false);

  const blocked = await browser.newContext({ colorScheme: 'dark' });
  await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } }));
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(server.url + '/inbox.html');
  await blockedPage.locator('#workspace').waitFor();
  await blockedPage.locator('[data-appearance]').selectOption('light');
  assert.equal(await blockedPage.locator('html').getAttribute('data-theme'), 'light');
  await blocked.close();
});
