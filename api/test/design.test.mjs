import { clickControl } from './navigation-helper.mjs';
import { openPreference, showView } from './navigation-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';

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
  if (screenshots) await mkdir(screenshots, { recursive: true });
  async function shot(name) {
    if (screenshots) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `${screenshots}/${baseline ? 'before' : 'after'}-${name}.png`, fullPage: !await page.locator('dialog[open]').count() });
    }
  }
  async function appearance(value, target = page) {
    await openPreference(target, 'appearance');
    await target.locator('[data-appearance]').selectOption(value);
  }
  async function fits() {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
  }
  await page.goto(server.url);
  await page.locator('#workspace').waitFor();
  if (!baseline) {
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.locator('#quickFocus').getAttribute('aria-current'), 'page');
    assert.ok((await page.locator('#captureText').boundingBox()).height >= 120);
  }
  await showView(page, 'capture'); await page.locator('#captureText').fill('Plan a walk by the river\nBook the bike tune-up\nPick up groceries for dinner');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '' && document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  for (const width of (baseline ? [320, 390, 768, 1440] : [320, 390, 393, 768, 1366, 1440, 2560])) {
    await page.setViewportSize({ width, height: 900 });
    await shot(`inbox-${width}`);
    if (!baseline) await fits();
  }
  if (baseline) return;
  await showView(page, 'capture'); await page.locator('#captureText').fill('Keep my capture while reviewing');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await showView(page, 'lists');
    assert.equal(await page.locator('#captureText').isVisible(), false);
    assert.equal(await page.locator('#listWorkspace').getAttribute('aria-current'), 'page');
    await fits(); await shot(`lists-${width}`);
    await showView(page, 'capture');
    assert.equal(await page.locator('#captureText').inputValue(), 'Keep my capture while reviewing');
  }
  await showView(page, 'capture'); await page.locator('#captureText').fill('');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('#captureText').focus();
  await page.keyboard.press('Shift+Tab');
  assert.ok(await page.getByRole('button', { name: 'Save on device', exact: true }).evaluate(el => el.matches(':focus-visible')));
  assert.equal(await page.getByRole('button', { name: 'Save on device', exact: true }).evaluate(el => getComputedStyle(el).outlineWidth), '3px');
  await page.keyboard.press('Shift+Tab');
  assert.ok(await page.getByRole('button', { name: 'Preview comma / semicolon split', exact: true }).evaluate(el => el.matches(':focus-visible')));
  await shot('inbox-keyboard-focus-390');
  await showView(page, 'capture'); await page.locator('#captureText').fill('A'.repeat(200));
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await page.setViewportSize({ width: 320, height: 900 });
  await fits();
  await showView(page, 'work'); await page.getByRole('button', { name: 'Edit ' + 'A'.repeat(200), exact: true }).click();
  assert.ok(await page.locator('#editor').evaluate(el => el.matches(':modal')));
  await fits();
  await page.locator('#edit [name=title]').fill('Preserved sheet draft');
  await shot('editor-sheet-320');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#editor').isVisible(), false);
  await showView(page, 'work'); await page.getByRole('button', { name: 'Edit ' + 'A'.repeat(200), exact: true }).click();
  assert.equal(await page.locator('#edit [name=title]').inputValue(), 'Preserved sheet draft');
  await page.setViewportSize({ width: 1440, height: 900 });
  const panel = await page.locator('#editor').boundingBox();
  assert.equal(panel.x + panel.width, 1440);
  await shot('editor-panel-1440');
  await page.locator('#cancelEdit').focus();
  await page.keyboard.press('Tab');
  // Native dialogs may allow a stop in browser chrome before cycling back.
  if (await page.evaluate(() => document.activeElement === document.body)) await page.keyboard.press('Tab');
  assert.ok(await page.locator('#editor').evaluate(el => el.contains(document.activeElement)), 'focus stays inside modal');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await waitForBrowser(page, async () => {
    const { transact } = await import('/inbox-store.js?v=9');
    return (await transact((await transact(null)).accountId)).draft.editOpen === false;
  });
  await page.reload();
  await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#editor').isVisible(), false);
  await page.locator('#resumeEdit').click();
  await page.locator('#editor').waitFor();
  assert.equal(await page.locator('#edit [name=title]').inputValue(), 'Preserved sheet draft');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 320, height: 900 });
  if (new URL(page.url()).hash === '#menu') await page.locator('#menuBack').click();

  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openPreference(page, 'task-options');
    assert.equal(await page.locator('#defaultsSurface').isVisible(), true);
    await fits(); await shot('native-defaults-' + width);
    await showView(page, 'capture'); await page.locator('#captureOptions > summary').click();
    await fits(); await shot('native-fields-' + width);
    await showView(page, 'capture'); await page.locator('#captureOptions > summary').click();
  }
  await page.setViewportSize({ width: 320, height: 900 });
  if (new URL(page.url()).hash === '#menu') await page.locator('#menuBack').click();

  // Measure resolved semantic colors, not just literal token values.
  function luminance(rgb) {
    return rgb.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; })
      .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  }
  async function dropdownContrast() {
    await page.waitForFunction(() => [...document.querySelectorAll('select option')]
      .some(option => option.closest('select')?.getClientRects().length));
    const options = await page.locator('select option').evaluateAll(options => options.filter(option => option.closest('select')?.getClientRects().length).map(option => {
      const style = getComputedStyle(option);
      return { label: option.textContent, color: style.color, background: style.backgroundColor };
    }));
    assert.ok(options.length > 0);
    for (const option of options) {
      const foreground = option.color.match(/[\d.]+/g)?.map(Number);
      const background = option.background.match(/[\d.]+/g)?.map(Number);
      assert.ok(foreground && background, `${option.label}: visible dropdown has resolved colors`);
      assert.ok(background.length === 3 || background[3] === 1, `${option.label}: option background is opaque`);
      const [a, b] = [luminance(foreground.slice(0, 3)), luminance(background.slice(0, 3))].sort((a, b) => b - a);
      assert.ok((a + .05) / (b + .05) >= 4.5, `${option.label}: dropdown text contrast is at least 4.5:1`);
    }
  }
  for (const theme of ['light', 'dark']) {
    await appearance(theme);
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
    await dropdownContrast();
    console.log(`${theme} minimum text contrast: ${minimum.toFixed(2)}:1`);
    if (theme === 'light') await shot('inbox-light-320');
  }
  await appearance('system');
  await page.reload();
  await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('[data-appearance]').inputValue(), 'system');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(247, 248, 250)');
  await dropdownContrast();
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
  await dropdownContrast();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#workspace').waitFor();
  assert.equal(new URL(page.url()).hash, '#preferences/appearance');
  assert.equal(await page.locator('[data-appearance]').inputValue(), 'system');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
  await fits();
  await dropdownContrast();
  await context.setOffline(false);
  await page.goto(server.url + '/shared.html');
  await page.locator('#sharedMain').waitFor();
  await dropdownContrast();
  await page.emulateMedia({ colorScheme: 'light' });
  await dropdownContrast();

  const blocked = await browser.newContext({ colorScheme: 'light' });
  await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } }));
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(server.url);
  await blockedPage.locator('#workspace').waitFor();
  assert.equal(await blockedPage.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
  await appearance('light', blockedPage);
  assert.equal(await blockedPage.locator('html').getAttribute('data-theme'), 'light');
  await blocked.close();
});
