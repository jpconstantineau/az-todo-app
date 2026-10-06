import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl } from './navigation-helper.mjs';

async function setup(t, user, mode) {
  documents.length = 0;
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  if (mode) await context.addInitScript(mode => {
    window.aiMode = mode; window.aiCalls = { creates: 0, prompts: 0, destroyed: 0 };
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: mode.absent ? undefined : {
      availability: async () => {
        if (aiMode.checkFail) throw Error('Check failed');
        if (aiMode.holdCheck) return new Promise(resolve => { window.finishCheck = resolve; });
        return aiMode.state;
      },
      create: options => {
        aiCalls.creates++; aiCalls.active = navigator.userActivation.isActive;
        options.monitor(new EventTarget());
        if (aiMode.createFail) return Promise.reject(Error('Download failed'));
        const model = { destroy() { aiCalls.destroyed++; }, prompt: async (text, options) => {
          aiCalls.prompts++; if (options.responseConstraint.properties.text) return JSON.stringify({ text: " with a next step" });
          return '{"items":[],"notes":"No actionable tasks."}';
        } };
        const ready = () => { aiMode.state = 'available'; return model; };
        if (aiMode.holdCreate) return new Promise(resolve => { window.finishCreate = () => resolve(ready()); });
        return Promise.resolve(ready());
      }
    } });
  }, mode);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('**/.auth/me', route => route.fulfill({ json: { clientPrincipal: { userId: user, userDetails: `${user}-handle` } } }));
  return { page, context, url: server.url, setUser(value) { user = value; } };
}
const status = (page, value) => page.waitForFunction(value => document.querySelector('#saveStatus').dataset.state === value, value);
const agentStatus = (page, value) => page.waitForFunction(value => document.querySelector('#agentStatus').dataset.state === value, value);
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=5')).transact('alice'));
async function shot(page, name) {
  if (!process.env.HEADER_SCREENSHOTS) return;
  await mkdir(process.env.HEADER_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.HEADER_SCREENSHOTS}/${name}.png` });
}

async function signedOut(page) {
  await page.waitForFunction(() => document.title === 'Sign in');
  assert.equal(await page.title(), 'Sign in');
  assert.equal(await page.locator('#signIn').isVisible(), true);
  assert.equal(await page.locator('#signedOut h1').innerText(), 'Welcome');
  for (const selector of ['#appHeader', '#accountName', '#workspaceSelect', '#saveStatus', '#agentStatus', '#agentLabel', '#appMenu', '#workspaceSkip', '#workspace', '#appUpdateStatus', '#preferences']) {
    assert.equal(await page.locator(selector).isVisible(), false, selector);
  }
  assert.doesNotMatch(await page.locator('body').innerText(), /Personal|Family|alice-handle|AI agent|workspace|Menu|Preferences|saved|pending/i);
}

test('login hides application chrome before the session check and after a late agent check', async t => {
  const { page, url } = await setup(t, null, { state: 'available', holdCheck: true });
  let holdSession;
  const session = new Promise(resolve => { holdSession = resolve; });
  await page.route('**/api/v1/session', route => holdSession(route));
  await page.goto(url);
  const pending = await session;
  await signedOut(page);
  assert.equal(await page.locator('#loginStatus').textContent(), 'Checking account…');
  await pending.continue();
  await page.waitForFunction(() => document.querySelector('#loginStatus').textContent === 'Sign in to continue.');
  await page.waitForFunction(() => !!window.finishCheck);
  await page.evaluate(() => finishCheck('available')); await agentStatus(page, 'available');
  // Worker notifications can also arrive while signed out.
  await page.evaluate(() => document.querySelector('#appUpdateStatus').textContent = 'An app update is ready. Open Menu → Preferences for details.');
  await signedOut(page);
});

test('login markup hides application chrome when the application module cannot load', async t => {
  const { page, url } = await setup(t, null);
  await page.route('**/inbox.js?*', route => route.abort());
  await page.goto(url);
  await signedOut(page);
});

test('fresh signed-out screen offers sign-in without an error or a saved-work claim', async t => {
  const { page, url } = await setup(t, null);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#loginStatus').textContent === 'Sign in to continue.');
  await signedOut(page);
  assert.equal(await page.locator('#error').isVisible(), false);
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#workspaceSelect').isVisible(), false);
  assert.equal(await page.locator('#saveStatus').isVisible(), false);
  assert.doesNotMatch(await page.locator('body').innerText(), /401|saved|pending|To-Do/i);
  await shot(page, 'signed-out');
});

for (const [mode, expected] of [[{ absent: true }, 'unavailable'], [{ state: 'unavailable' }, 'unavailable'], [{ checkFail: true }, 'error'], [{ state: 'downloadable' }, 'downloadable'], [{ state: 'downloading' }, 'busy'], [{ state: 'available' }, 'available']]) {
  test('agent header identifies model availability: ' + JSON.stringify(mode), async t => {
    const { page, url } = await setup(t, 'alice', mode);
    await page.goto(url); await status(page, 'confirmed'); await agentStatus(page, expected);
    const button = page.locator('#agentStatus');
    assert.equal(await button.isVisible(), true);
    assert.equal(await button.getAttribute('aria-disabled'), String(expected === 'unavailable'));
    assert.equal(await page.locator('.agent-unavailable').isVisible(), expected === 'unavailable');
    assert.equal(await button.getAttribute('aria-label'), await page.locator('#agentLabel').textContent());
    for (const id of ['extractAuto', 'extractLists', 'extractStart']) {
      assert.equal(await page.locator('#' + id).isDisabled(), expected === 'unavailable' || !!mode.checkFail);
    }
    assert.equal(await page.locator('#extractManual').count(), 0);
    assert.equal(await page.locator('#captureAI').isVisible(), expected !== 'unavailable' && !mode.checkFail);
    assert.equal(await page.locator('#extractionStatus').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => aiCalls), { creates: 0, prompts: 0, destroyed: 0 });
    assert.ok((await button.boundingBox()).x > (await page.locator('#saveStatus').boundingBox()).x);
    if (expected === 'unavailable') { await button.focus(); await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => aiCalls.creates), 0); }
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await shot(page, `agent-${expected}-${theme}-${width}`);
    }
  });
}

test('capture AI controls wait for the initial availability check', async t => {
  const { page, url } = await setup(t, 'alice', { state: 'available', holdCheck: true });
  await page.goto(url); await status(page, 'confirmed');
  await page.waitForFunction(() => !!window.finishCheck);
  await agentStatus(page, 'busy');
  for (const id of ['extractAuto', 'extractLists', 'extractStart']) assert.equal(await page.locator('#' + id).isDisabled(), true);
  assert.equal(await page.locator('#captureAI').isVisible(), false);
  assert.equal(await page.locator('#extractionStatus').isVisible(), false);
  await page.evaluate(() => finishCheck('available')); await agentStatus(page, 'available');
  assert.equal(await page.locator('#captureAI').isVisible(), true);
  assert.equal(await page.locator('#extractionStatus').isVisible(), false);
  for (const id of ['extractAuto', 'extractLists', 'extractStart']) assert.equal(await page.locator('#' + id).isEnabled(), true);
});

test('unavailable agent has stroke-wide circle clearance and keeps its size when ready', async t => {
  const { page, url } = await setup(t, 'alice', { state: 'unavailable' });
  await page.goto(url); await status(page, 'confirmed'); await agentStatus(page, 'unavailable');
  const robot = page.locator('.agent-robot'), unavailableBounds = await robot.boundingBox();
  const clearance = await page.evaluate(() => {
    const svg = document.querySelector('.agent-icon'), circle = document.querySelector('.agent-unavailable circle');
    const stroke = parseFloat(getComputedStyle(circle).strokeWidth);
    let radius = 0;
    for (const shape of document.querySelector('.agent-robot').children) {
      const matrix = svg.getScreenCTM().inverse().multiply(shape.getScreenCTM());
      const halfStroke = parseFloat(getComputedStyle(shape).strokeWidth) * Math.hypot(matrix.a, matrix.b) / 2;
      const length = shape.getTotalLength();
      for (let step = 0; step <= 256; step++) {
        const point = shape.getPointAtLength(length * step / 256).matrixTransform(matrix);
        radius = Math.max(radius, Math.hypot(point.x - circle.cx.baseVal.value, point.y - circle.cy.baseVal.value) + halfStroke);
      }
    }
    return { gap: circle.r.baseVal.value - stroke / 2 - radius, stroke };
  });
  assert.ok(clearance.gap >= clearance.stroke, JSON.stringify(clearance));
  await page.evaluate(async () => { aiMode.state = 'available'; await (await import('/local-agent.js?v=1')).checkModel(); });
  await agentStatus(page, 'available');
  assert.deepEqual(await robot.boundingBox(), unavailableBounds);
  assert.equal(await page.locator('.agent-unavailable').isVisible(), false);
});

test('header prepares the model from a keyboard gesture, ignores duplicate clicks and stale availability, then enables capture', async t => {
  const { page, url } = await setup(t, 'alice', { state: 'downloadable', holdCreate: true });
  await page.goto(url); await status(page, 'confirmed'); await agentStatus(page, 'downloadable');
  await page.evaluate(() => {
    aiMode.holdCheck = true;
    void import('/local-agent.js?v=1').then(agent => agent.checkModel());
  });
  await page.waitForFunction(() => !!window.finishCheck);
  await page.locator('#agentStatus').focus(); await page.keyboard.press('Enter'); await agentStatus(page, 'busy');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => aiCalls.creates), 1);
  assert.equal(await page.evaluate(() => aiCalls.active), true);
  assert.equal(await page.locator('#agentStatus').evaluate(el => el === document.activeElement), true);
  await page.evaluate(() => finishCreate()); await agentStatus(page, 'available');
  await page.evaluate(() => { aiMode.holdCheck = false; finishCheck('downloadable'); });
  assert.equal(await page.locator('#agentStatus').getAttribute('data-state'), 'available');
  assert.equal(await page.evaluate(() => aiCalls.destroyed), 1);
  assert.equal(await page.evaluate(() => aiCalls.prompts), 0);
  assert.equal((await local(page)).queue.length, 0); assert.equal(documents.length, 0);
  await page.locator('#captureAI summary').click(); await page.locator('#extractAuto').check();
  await page.evaluate(() => aiMode.holdCreate = false);
  await page.locator('#captureText').fill('A thought to review'); await page.locator('#captureGhost').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), 'A thought to review');
  assert.equal((await local(page)).draft.extraction.draft, null);
  await agentStatus(page, 'available');
  assert.equal(await page.evaluate(() => aiCalls.prompts), 1);
});

test('header download failures stay red and can be retried without changing saved work', async t => {
  const { page, context, url } = await setup(t, 'alice', { state: 'downloadable', createFail: true });
  await page.goto(url); await status(page, 'confirmed'); await agentStatus(page, 'downloadable');
  await page.locator('#agentStatus').click(); await agentStatus(page, 'error');
  assert.equal(await page.locator('.agent-unavailable').isVisible(), false);
  assert.match(await page.locator('#agentStatus').getAttribute('title'), /error.*retry/);
  await page.evaluate(() => aiMode.createFail = false);
  await page.locator('#agentStatus').click(); await agentStatus(page, 'available');
  await context.setOffline(true); await status(page, 'offline');
  assert.equal(await page.locator('#agentStatus').getAttribute('data-state'), 'available');
  assert.equal(await page.evaluate(() => aiCalls.prompts), 0);
  assert.equal((await local(page)).queue.length, 0);
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
  assert.equal(await page.locator('#captureHeading').innerText(), 'Capture');
  assert.equal(await page.locator('#captureText').getAttribute('placeholder'), 'Get it out of your head. Write your items here. One item per line. Ctrl/⌘ + Enter saves.');
  assert.equal(await page.locator('#captureHelp').getAttribute('class'), 'sr-only');
  assert.equal(await page.locator('#captureText').getAttribute('aria-describedby'), 'captureHelp captureCompletionHint');
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
    const heading = await page.locator('#captureHeading').boundingBox();
    const save = await page.locator('.capture-header button').boundingBox();
    const text = await page.locator('#captureText').boundingBox();
    assert.ok(heading.width > 1 && heading.height > 1, 'Capture heading must be visually rendered');
    assert.equal(heading.x, text.x, 'Capture heading aligns with the textarea');
    assert.ok(heading.x + heading.width < save.x, 'Save stays to the right of the heading');
    assert.ok(heading.y + heading.height < text.y, 'Capture heading stays above the textarea');
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
  await signedOut(page);
  assert.deepEqual((await local(page)).queue, queued);
});

test('sign-out in another tab closes preferences and hides account chrome, then login restores it', async t => {
  const { page, context, url, setUser } = await setup(t, 'alice');
  await page.route('**/.auth/logout?**', route => route.fulfill({ status: 204 }));
  await page.goto(url); await status(page, 'confirmed');
  const second = await context.newPage();
  await second.goto(url); await status(second, 'confirmed');
  await clickControl(second.locator('[data-open-preferences]'));
  await second.locator('#preferences').waitFor();
  setUser(null);
  await clickControl(page.locator('#signOut'));
  await page.locator('#workspace').waitFor({ state: 'hidden' });
  await second.locator('#workspace').waitFor({ state: 'hidden' });
  await signedOut(page); await signedOut(second);
  // A previously opened menu must also be closed when the session ends.
  assert.equal(await second.locator('#appMenu').getAttribute('open'), null);
  setUser('alice');
  await page.reload(); await status(page, 'confirmed');
  assert.equal(await page.locator('#appHeader').isVisible(), true);
  assert.equal(await page.locator('#agentStatus').isVisible(), true);
  assert.equal(await page.locator('#signedOut').isVisible(), false);
  assert.equal(await page.title(), 'Capture · Personal');
});
