import { clickControl } from './navigation-helper.mjs';
import { test } from 'node:test';
import { waitForBrowser } from './browser-wait.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';

const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;
const ready = page => page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');

async function setup(t, options = {}, serverOptions = {}) {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice', ...serverOptions }); t.after(server.close);
  const browser = await chromium.launch({ channel }); t.after(() => browser.close());
  const context = await browser.newContext(options);
  const page = await context.newPage();
  return { server, browser, context, page };
}
async function offer(page, outcome = 'dismissed', fail = false) {
  return page.evaluate(({ outcome, fail }) => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { window.promptCalls = (window.promptCalls || 0) + 1; if (fail) throw new Error('Unavailable'); };
    event.userChoice = Promise.resolve({ outcome });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }, { outcome, fail });
}

test('PWA: installation is user-triggered, dismissal persists, and accepted/installed states hide controls', async t => {
  const { page, server } = await setup(t);
  await page.goto(server.url); await ready(page);
  assert.equal(await page.locator('#appUpdateStatus').textContent(), '');
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Preferences', exact: true }));
  assert.equal(await page.locator('#installApp').isVisible(), false);
  assert.equal(await offer(page), true);
  assert.equal(await page.evaluate(() => window.promptCalls || 0), 0);
  await page.getByRole('button', { name: 'Install app', exact: true }).click();
  assert.equal(await page.evaluate(() => window.promptCalls), 1);
  assert.equal(await page.locator('#installApp').isVisible(), false);
  assert.equal(await page.locator('#installHelp summary').evaluate(el => el === document.activeElement), true);
  await page.reload(); await ready(page);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Preferences', exact: true }));
  await offer(page);
  assert.equal(await page.locator('#installApp').isVisible(), false, 'dismissal survives reload');
  assert.equal(await page.locator('#installHelp').isVisible(), true);
  await page.evaluate(() => localStorage.removeItem('todo-install-dismissed'));
  await page.reload(); await ready(page);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Preferences', exact: true }));
  await offer(page, 'accepted');
  await page.getByRole('button', { name: 'Install app', exact: true }).click();
  assert.match(await page.locator('#installStatus').textContent(), /is installed/);
  assert.equal(await page.locator('#installHelp').isVisible(), false);
  await offer(page);
  assert.equal(await page.locator('#installApp').isVisible(), false);
  await page.reload(); await ready(page);
  await page.evaluate(() => dispatchEvent(new Event('appinstalled')));
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Preferences', exact: true }));
  await offer(page);
  assert.equal(await page.locator('#installApp').isVisible(), false);
});

test('PWA: prompt failure and blocked preference storage leave capture and manual installation usable', async t => {
  const { page, server } = await setup(t);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
  });
  await page.goto(server.url); await ready(page); await page.locator('#workspace').waitFor();
  await page.locator('#captureText').fill('Keep my capture');
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Preferences', exact: true }));
  await offer(page, 'dismissed', true);
  await page.getByRole('button', { name: 'Install app', exact: true }).click();
  assert.match(await page.locator('#installStatus').textContent(), /could not open/);
  assert.equal(await page.locator('#installHelp').isVisible(), true);
  await offer(page);
  await page.getByRole('button', { name: 'Install app', exact: true }).click();
  await offer(page);
  assert.equal(await page.locator('#installApp').isVisible(), false);
  await page.getByRole('button', { name: 'Close preferences', exact: true }).click();
  assert.equal(await page.locator('#captureText').inputValue(), 'Keep my capture');
});

test('PWA: iPhone guidance, standalone suppression and responsive preferences', async t => {
  const { page, context, server, browser } = await setup(t, {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
  });
  await page.goto(server.url); await ready(page);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Preferences', exact: true }));
  await page.locator('#installHelp summary').click();
  assert.match(await page.locator('#installInstructions').textContent(), /Safari.*Share.*Add to Home Screen/);
  const screenshots = process.env.PWA_SCREENSHOTS;
  if (screenshots) { await mkdir(screenshots, { recursive: true }); console.log('PWA evidence browser:', browser.version()); }
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['dark', 'light']) {
      await page.locator('[data-appearance]').selectOption(theme);
      await page.locator('#installHelp summary').focus();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.locator('#preferences').evaluate(el => el.scrollWidth <= el.clientWidth));
      if (screenshots && [390, 1440].includes(width)) await page.screenshot({ path: screenshots + '/install-' + theme + '-' + width + '.png' });
    }
  }
  await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.reload(); await ready(page);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Preferences', exact: true }));
  await offer(page);
  assert.equal(await page.locator('#installApp').isVisible(), false);
  assert.equal(await page.locator('#installHelp').isVisible(), false);
  assert.match(await page.locator('#installStatus').textContent(), /is installed/);
});

test('PWA: manifest is parsed, public assets work anonymously, and offline navigation excludes auth/API', async t => {
  const { page, context, server } = await setup(t, {}, { browserUser: () => null });
  await page.goto(server.url); await ready(page);
  assert.equal(await page.locator('link[rel=manifest]').getAttribute('href'), '/manifest.json');
  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  assert.deepEqual(manifest.errors, []);
  assert.equal(JSON.parse(manifest.data).start_url, '/');
  const config = JSON.parse(await readFile(new URL('../../html/staticwebapp.config.json', import.meta.url), 'utf8'));
  for (const path of ['/manifest.json', '/icons/*']) assert.ok(config.navigationFallback.exclude.includes(path));
  assert.equal(config.mimeTypes['.json'], 'application/json');
  for (const [path, type] of [['/manifest.json', 'application/json'], ['/icons/icon-192.png', 'image/png'], ['/icons/icon-512.png', 'image/png'], ['/icons/apple-touch-icon.png', 'image/png']]) {
    const response = await context.request.get(server.url + path);
    assert.equal(response.status(), 200); assert.equal(response.headers()['content-type'], type);
  }
  await page.evaluate(() => Promise.all([fetch('/.auth/me'), fetch('/api/v1/session')]));
  await context.setOffline(true);
  for (const path of ['/?launch=home', '/index.html?launch=home', '/inbox.html']) {
    await page.goto(server.url + path); await ready(page);
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Sign in online'));
  }
  const keys = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(r => new URL(r.url).pathname)))).flat());
  assert.ok(keys.includes('/manifest.json'));
  assert.ok(!keys.some(path => path.startsWith('/api/') || path.startsWith('/.auth/')));
  assert.equal(await page.evaluate(() => fetch('/.auth/me').then(() => true, () => false)), false);
  assert.equal(await page.evaluate(() => fetch('/api/v1/session').then(() => true, () => false)), false);
});

test('PWA: failed asset download retains the active shell; successful update waits with drafts and outbox intact', { timeout: 90000 }, async t => {
  const worker = await readFile(new URL('../../html/inbox-sw.js', import.meta.url), 'utf8');
  let version = 'current';
  const { page, context, server } = await setup(t, {}, { rejectOperations: () => true, assetContents: path => {
    if (path !== '/inbox-sw.js' || version === 'current') return;
    const next = worker.replaceAll('shell-v23', 'shell-next');
    return version === 'failure' ? next.replace('ASSETS.push(', "ASSETS.push('/missing-update-asset', ") : next;
  } });
  await page.goto(server.url); await ready(page); await page.locator('#workspace').waitFor();
  await page.locator('#captureText').fill('Pending across update');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await page.locator('#captureText').fill('Draft across update');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=23')).transact('alice')).draft.capture.text === 'Draft across update');
  const local = () => page.evaluate(async () => (await import('/inbox-store.js?v=23')).transact('alice'));
  const before = await local();
  assert.equal(before.queue.length, 1, 'the update must exercise a pending operation');
  version = 'failure';
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(() => document.querySelector('#appUpdateStatus').textContent.includes('could not finish'));
  assert.deepEqual((await local()).queue, before.queue);
  assert.equal(await page.evaluate(async () => (await (await caches.open('todo-inbox-shell-next')).keys()).length), 0, 'addAll fails atomically');
  await context.setOffline(true); await page.reload(); await ready(page); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'Draft across update');
  await context.setOffline(false);
  version = 'success';
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(() => document.querySelector('#appUpdateStatus').textContent.includes('update is ready'));
  assert.ok(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting));
  assert.deepEqual((await local()).queue, before.queue);
  assert.deepEqual((await local()).draft, before.draft);
  assert.ok(await page.evaluate(() => caches.has('todo-inbox-shell-v23')));
});
