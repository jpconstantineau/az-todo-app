import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl } from './navigation-helper.mjs';

async function setup(t, user) {
  documents.length = 0;
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/.auth/me', route => route.fulfill({ json: { clientPrincipal: { userId: user, userDetails: `${user}-handle` } } }));
  return { page, context, url: server.url, setUser(value) { user = value; } };
}
const status = (page, value) => page.waitForFunction(value => document.querySelector('#saveStatus').dataset.state === value, value);
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=44')).transact('alice'));
async function shot(page, name) {
  if (!process.env.HEADER_SCREENSHOTS) return;
  await mkdir(process.env.HEADER_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.HEADER_SCREENSHOTS}/${name}.png` });
}

test('fresh signed-out screen offers sign-in without an error or a saved-work claim', async t => {
  const { page, url } = await setup(t, null);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#loginStatus').textContent === 'Sign in to open your workspace.');
  assert.equal(await page.locator('#signIn').isVisible(), true);
  assert.equal(await page.locator('#error').isVisible(), false);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#workspaceSelect').isVisible(), false);
  assert.equal(await page.locator('#saveStatus').isVisible(), false);
  assert.equal(await page.locator('h1').innerText(), 'Personal');
  assert.equal(await page.locator('#accountName').innerText(), 'Welcome');
  assert.doesNotMatch(await page.locator('body').innerText(), /401|saved|pending|To-Do/i);
  await shot(page, 'signed-out');
});

test('header follows workspace selection and save state, then clears identity on expiry', { timeout: 60000 }, async t => {
  const { page, context, url, setUser } = await setup(t, 'alice');
  await page.goto(url); await status(page, 'confirmed');
  await page.waitForFunction(() => document.querySelector('#accountName').textContent === 'alice-handle');
  assert.equal(await page.locator('#accountName').evaluate(el => el.closest('a, button')), null);
  assert.equal(await page.locator('#workspaceSelect').inputValue(), 'personal');
  assert.equal(await page.title(), 'Capture · Personal');
  assert.equal(await page.locator('#manageWorkspaces').isVisible(), false);
  for (const id of ['sessionStatus', 'offlineStatus', 'syncStatus']) assert.equal(await page.locator(`#${id}`).isVisible(), false);
  assert.equal(await page.locator('#capture > fieldset > label').innerText(), 'Capture items');
  assert.equal(await page.locator('.capture-header button').innerText(), '');
  assert.ok((await page.locator('.capture-header button').boundingBox()).y < (await page.locator('#captureText').boundingBox()).y);
  await clickControl(page.locator('#manageWorkspaces'));
  await page.locator('#createWorkspace input').fill('Family');
  await page.locator('#createWorkspace button').click();
  await page.getByRole('button', { name: 'Rename workspace: Family', exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click();
  await page.locator('#appMenu > summary').click();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Family' });
  await page.waitForFunction(() => document.title === 'Capture · Family');
  await status(page, 'confirmed');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot(page, `capture-${width}`);
  }
  // The capture shortcut still submits from the textarea after moving the button.
  await context.setOffline(true); await status(page, 'offline');
  assert.equal(await page.locator('#saveStatus').getAttribute('title'), 'Working offline');
  await page.locator('#captureText').fill('Family offline task');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  assert.equal((await local(page)).queue.length, 1);
  let holdOperation;
  const operation = new Promise(resolve => { holdOperation = resolve; });
  await page.route('**/api/v1/operations', route => holdOperation(route));
  await context.setOffline(false);
  await status(page, 'pending');
  const pending = await operation;
  assert.match(await page.locator('#saveStatus').getAttribute('title'), /pending/);
  await pending.continue(); await status(page, 'confirmed');
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(documents.filter(doc => doc.kind === 'record' && doc.record.title === 'Family offline task').length, 1);
  // Expiry hides the previous identity and preserves its unsent work.
  await context.setOffline(true);
  await page.locator('#captureText').fill('Keep pending task');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  const queued = (await local(page)).queue;
  assert.equal(queued.length, 1);
  setUser(null); await context.setOffline(false);
  await page.locator('#workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#error').isVisible(), false);
  assert.equal(await page.locator('#saveStatus').isVisible(), false);
  assert.equal(await page.locator('#accountName').innerText(), 'Welcome');
  assert.equal(await page.locator('h1').innerText(), 'Personal');
  assert.equal(await page.locator('#signIn').isVisible(), true);
  assert.deepEqual((await local(page)).queue, queued);
});
