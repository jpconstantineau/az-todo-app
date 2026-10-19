import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl, openUtility, openPreferences, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

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
const accountStatus = (page, value) => page.waitForFunction(value => document.querySelector('#accountStatus').dataset.state === value, value);
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=21')).transact('alice'));
async function shot(page, name) {
  if (!process.env.HEADER_SCREENSHOTS) return;
  await mkdir(process.env.HEADER_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.HEADER_SCREENSHOTS}/${name}.png` });
}

async function loadingShell(page) {
  await page.waitForFunction(() => document.title === 'To-Do');
  assert.equal(await page.title(), 'To-Do');
  assert.equal(await page.locator('#signedOut h1').innerText(), 'Welcome');
  assert.equal(await page.locator('#loginStatus').textContent(), 'Opening your workspace…');
  assert.equal(await page.locator('#appHeader').isVisible(), true);
  assert.equal(await page.locator('#accountStatus').isVisible(), true);
  assert.equal(await page.locator('#accountStatus').isDisabled(), true);
  assert.equal(await page.locator('#accountStatus').getAttribute('aria-label'), 'Checking sign-in status');
  for (const selector of ['#accountName', '#workspaceSelect', '#saveStatus', '#agentStatus', '#agentLabel', '#appMenu', '#workspaceSkip', '#workspace', '#appUpdateStatus', '#preferencesView', '#utilityView']) {
    assert.equal(await page.locator(selector).isVisible(), false, selector);
  }
  await shot(page, 'account-checking');
}

async function deviceLocal(page) {
  await page.waitForFunction(() => !document.querySelector('#workspace').hidden && document.querySelector('#accountName').textContent === 'On this device');
  await page.waitForFunction(() => document.title.endsWith(' · Personal'));
  assert.equal(await page.locator('#signedOut').isVisible(), false);
  assert.equal(await page.locator('#workspace').isVisible(), true);
  assert.equal(await page.locator('#appHeader').isVisible(), true);
  assert.equal(await page.locator('#signInToSync').getAttribute('hidden'), null);
  assert.equal(await page.locator('#signOut').isVisible(), false);
  assert.match(await page.title(), / · Personal$/);
  await accountStatus(page, 'signed-out');
  assert.equal(await page.locator('.account-question').isVisible(), true);
}

test('loading hides application chrome before the session check and then opens device-local use', async t => {
  const { page, url } = await setup(t, null, { state: 'available', holdCheck: true });
  let holdSession;
  const session = new Promise(resolve => { holdSession = resolve; });
  await page.route('**/api/v1/session', route => holdSession(route));
  await page.goto(url);
  const pending = await session;
  await loadingShell(page);
  await pending.continue();
  await deviceLocal(page);
  await page.waitForFunction(() => !!window.finishCheck);
  await page.evaluate(() => finishCheck('available')); await agentStatus(page, 'available');
  // Worker notifications can also arrive while using the local profile.
  await page.evaluate(() => document.querySelector('#appUpdateStatus').textContent = 'An app update is ready. Open Menu → Preferences for details.');
  await deviceLocal(page);
});

test('loading markup hides application chrome when the application module cannot load', async t => {
  const { page, url } = await setup(t, null);
  await page.route('**/inbox.js?*', route => route.abort());
  await page.goto(url);
  await loadingShell(page);
});

test('fresh signed-out session opens the device-local workspace without an error', async t => {
  const { page, url } = await setup(t, null);
  await page.goto(url);
  await deviceLocal(page);
  assert.equal(await page.locator('#error').isVisible(), false);
  assert.equal(await page.locator('#workspaceSelect').isVisible(), true);
  assert.equal(await page.locator('#saveStatus').isVisible(), true);
  assert.match(await page.locator('#connectionLabel').textContent(), /Saved on this device/);
  assert.doesNotMatch(await page.locator('body').innerText(), /401/);
  await shot(page, 'device-local');
  if (process.env.HEADER_SCREENSHOTS) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(mode => todoAppearance.choose(mode, 'hashicorp'), mode);
    await shot(page, `account-signed-out-${mode}-320`);
  }
});

test('account avatar stays accessible across routes, themes and narrow layouts', async t => {
  const { page, url } = await setup(t, 'alice');
  const longName = 'A very long account identity with no short display name';
  await page.route('**/.auth/me', route => route.fulfill({ json: { clientPrincipal: { userId: 'alice', userDetails: longName } } }));
  await page.goto(url); await status(page, 'confirmed'); await accountStatus(page, 'authenticated');
  await page.waitForFunction(name => document.querySelector('#accountName').textContent === name, longName);
  const avatar = page.getByRole('button', { name: 'Signed in — account status', exact: true });
  assert.equal(await avatar.getAttribute('title'), 'Signed in — account status');
  assert.equal(await avatar.locator('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.account-question').isVisible(), false);
  await clickControl(page.locator('#manageWorkspaces'));
  await page.locator('#createWorkspace input').fill('A very long workspace name to truncate');
  await page.locator('#createWorkspace button').click();
  await page.getByRole('button', { name: 'Rename workspace: A very long workspace name to truncate', exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click(); await page.locator('#menuBack').click();
  await page.locator('#workspaceSelect').selectOption({ label: 'A very long workspace name to truncate' });
  await page.waitForFunction(() => document.title === 'Capture · A very long workspace name to truncate');
  for (const width of [320, 1440]) for (const style of ['hashicorp', 'hmi', 'hmi-cvd']) for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(({ mode, style }) => todoAppearance.choose(mode, style), { mode, style });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const control of ['#accountStatus', '#agentStatus', '#appMenu', '#workspaceSelect']) {
      const bounds = await page.locator(control).boundingBox();
      assert.ok(bounds.width >= 44 && bounds.height >= 44, control);
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, control);
    }
    assert.equal(await avatar.evaluate(button => getComputedStyle(button).color), await page.locator('#saveStatus').evaluate(icon => getComputedStyle(icon).color));
    await shot(page, `account-${style}-${mode}-${width}`);
  }
  for (const view of ['capture', 'work', 'lists', 'plan', 'execute', 'reviews']) {
    await showView(page, view); assert.equal(await avatar.isVisible(), true);
  }
  await page.locator('#appMenu').click(); await page.locator('#menuView').waitFor(); assert.equal(await avatar.isVisible(), true);
  await openPreferences(page); assert.equal(await avatar.isVisible(), true);
  await openUtility(page, 'data-recovery/export'); assert.equal(await avatar.isVisible(), true);
  await page.locator('#agentStatus').focus(); await page.keyboard.press('Tab');
  assert.equal(await avatar.evaluate(button => document.activeElement === button), true);
  assert.equal(await avatar.evaluate(button => getComputedStyle(button).outlineStyle), 'solid');
  await page.keyboard.press('Enter');
  await page.locator('#connectionHeading').waitFor();
  assert.equal(new URL(page.url()).hash, '#app-device/connection');
  assert.equal(await avatar.isVisible(), true);
});

test('signed-out avatar journals the current draft and adoption intent before login', async t => {
  const { page, url } = await setup(t, null);
  await page.goto(url); await deviceLocal(page);
  const avatar = page.getByRole('button', { name: 'Not signed in — sign in to sync', exact: true });
  assert.equal(await avatar.getAttribute('title'), 'Not signed in — sign in to sync');
  assert.equal(await avatar.evaluate(button => getComputedStyle(button).color), await page.locator('body').evaluate(body => {
    const sample = document.createElement('span'); sample.style.color = 'var(--error)'; body.append(sample);
    const color = getComputedStyle(sample).color; sample.remove(); return color;
  }));
  // No input event: the login handler itself must journal this current value.
  await page.locator('#captureText').evaluate(input => { input.value = 'Draft at sign-in'; });
  const login = page.waitForRequest(request => request.url().includes('/.auth/login/github?'));
  await page.route('**/.auth/login/github?**', route => route.fulfill({ status: 204 }));
  await page.locator('#agentStatus').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  const request = await login;
  assert.equal(new URL(request.url()).pathname + new URL(request.url()).search, '/.auth/login/github?post_login_redirect_uri=/');
  const saved = await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=21');
    return { profile: await store.transact(store.LOCAL_PROFILE), session: await store.transact(null), nonce: sessionStorage.getItem('todo-adopt-local') };
  });
  assert.equal(saved.profile.draft.capture.text, 'Draft at sign-in');
  assert.ok(saved.nonce); assert.equal(saved.session.adoptLocal, saved.nonce);
});

for (const control of ['avatar', 'menu']) for (const failure of ['draft', 'intent', 'tab-storage']) {
  test(`${control} login stops safely when ${failure} storage fails`, async t => {
    const { page, url } = await setup(t, null);
    await page.goto(url); await deviceLocal(page);
    await page.locator('#captureText').fill('Previously saved draft');
    await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=21')).transact('device-local')).draft.capture.text === 'Previously saved draft');
    if (control === 'menu') { await page.locator('#appMenu').click(); await page.locator('#menuView').waitFor(); }
    let logins = 0;
    await page.route('**/.auth/login/github?**', route => { logins++; return route.fulfill({ status: 204 }); });
    await page.evaluate(failure => {
      document.querySelector('#captureText').value = 'Current draft must survive';
      window.originalPut = IDBObjectStore.prototype.put;
      window.originalSetItem = Storage.prototype.setItem;
      IDBObjectStore.prototype.put = function (value, key) {
        if (failure === 'draft' && key === 'local-profile' || failure === 'intent' && key === 'session' && value.adoptLocal) throw new Error('Injected login storage failure');
        return originalPut.call(this, value, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (failure === 'tab-storage' && key === 'todo-adopt-local') throw new Error('Injected tab storage failure');
        return originalSetItem.call(this, key, value);
      };
    }, failure);
    await page.locator(control === 'avatar' ? '#accountStatus' : '#signInToSync').click();
    await page.locator('#error').waitFor();
    await page.waitForFunction(() => /could not be saved|Injected/.test(document.querySelector('#error').textContent));
    assert.equal(logins, 0);
    const saved = await page.evaluate(async () => {
      IDBObjectStore.prototype.put = originalPut; Storage.prototype.setItem = originalSetItem;
      const store = await import('/inbox-store.js?v=21');
      return { session: await store.transact(null), profile: await store.transact('device-local'), nonce: sessionStorage.getItem('todo-adopt-local') };
    });
    assert.ok(!saved.session.adoptLocal); assert.equal(saved.nonce, null);
    assert.equal(saved.session.activeProfile, 'device-local');
    assert.deepEqual(saved.profile.queue, []);
    assert.equal(saved.profile.draft.capture.text, failure === 'draft' ? 'Previously saved draft' : 'Current draft must survive');
    assert.equal(await page.locator('#captureText').inputValue(), 'Current draft must survive');
    if (failure === 'draft') assert.equal(JSON.parse(await page.locator('#recoveryText').inputValue()).draft.capture.text, 'Current draft must survive');
  });
}

test('unverified cached account reauth journals its own draft without adoption intent', async t => {
  const { page, context, url } = await setup(t, 'alice');
  await page.goto(url); await status(page, 'confirmed'); await accountStatus(page, 'authenticated');
  await context.setOffline(true); await accountStatus(page, 'unverified');
  await page.route('**/api/v1/session', route => route.abort());
  await context.setOffline(false); await status(page, 'confirmed'); await accountStatus(page, 'unverified');
  await page.locator('#captureText').evaluate(input => { input.value = 'Alice reauthentication draft'; });
  const login = page.waitForRequest(request => request.url().includes('/.auth/login/github?'));
  await page.route('**/.auth/login/github?**', route => route.fulfill({ status: 204 }));
  await page.getByRole('button', { name: 'Sign-in status unverified — sign in', exact: true }).click();
  await login;
  const saved = await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=21');
    return { account: await store.transact('alice'), session: await store.transact(null), nonce: sessionStorage.getItem('todo-adopt-local') };
  });
  assert.equal(saved.account.draft.capture.text, 'Alice reauthentication draft');
  assert.equal(saved.session.activeProfile, 'alice');
  assert.ok(!saved.session.adoptLocal); assert.equal(saved.nonce, null);
  await page.unroute('**/api/v1/session');
  await clickControl(page.locator('#sync')); await accountStatus(page, 'authenticated');
});

test('account transition exposes a checking avatar while the new profile is still opening', async t => {
  const { page, url, setUser } = await setup(t, 'alice');
  await page.goto(url); await status(page, 'confirmed'); await accountStatus(page, 'authenticated');
  await page.evaluate(() => {
    const transact = IDBDatabase.prototype.transaction;
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    window.holdProfile = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = transact.apply(this, args);
      Object.defineProperty(transaction, 'oncomplete', { set(handler) {
        complete.set.call(transaction, event => {
          if (holdProfile && document.querySelector('#appHeader').dataset.ready === 'false') {
            holdProfile = false; window.finishProfile = () => handler(event);
          } else handler(event);
        });
      } });
      return transaction;
    };
  });
  setUser('bob'); await clickControl(page.locator('#sync'));
  await page.waitForFunction(() => !!window.finishProfile);
  await accountStatus(page, 'checking');
  assert.equal(await page.locator('#accountStatus').isVisible(), true);
  assert.equal(await page.locator('#accountStatus').isDisabled(), true);
  for (const id of ['accountName', 'workspaceSelect', 'saveStatus', 'agentStatus', 'appMenu', 'workspace']) assert.equal(await page.locator('#' + id).isVisible(), false, id);
  await page.evaluate(() => finishProfile());
  await accountStatus(page, 'authenticated'); await status(page, 'confirmed');
  await page.waitForFunction(() => document.querySelector('#accountName').textContent === 'bob-handle');
  assert.equal(await page.locator('#items article').count(), 0);
});

for (const boundary of ['defaults', 'session']) test(`late ${boundary} storage completion cannot reopen or render a signed-out account`, async t => {
  const { page, url } = await setup(t, 'alice');
  let includeDefaults = false;
  await page.route('**/api/v1/session', route => route.fulfill({ json: {
    apiVersion: 1, accountId: 'alice', ...(includeDefaults ? { defaultSettings: { contexts: [] } } : {})
  } }));
  await page.goto(url); await status(page, 'confirmed'); await accountStatus(page, 'authenticated');
  await page.locator('#appMenu').click(); await page.locator('#menuView').waitFor();
  await page.evaluate(async boundary => {
    const store = await import('/inbox-store.js?v=21');
    await store.transact('alice', profile => {
      profile.records['item:private'] = { type: 'item', id: 'private', title: 'Alice private task', accountId: 'alice', version: 1, status: 'inbox', workspaceId: 'personal', collectionRefs: [] };
      profile.queue = [{ operation: { apiVersion: 1, accountId: 'alice', operationId: 'alice-pending', mutations: [
        { type: 'item', id: 'pending', action: 'create', expectedVersion: 0, fields: { title: 'Alice pending task', workspaceId: 'personal', collectionRefs: [], status: 'inbox' } }
      ] } }];
    });
    await store.transact(store.LOCAL_PROFILE, profile => { profile.draft.capture = { text: 'Device-only draft' }; });
    const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put;
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    let held = false;
    IDBObjectStore.prototype.get = function (key) {
      if (boundary === 'session' && key === 'session' && this.transaction.mode === 'readonly' && !held) {
        held = true;
        const transaction = this.transaction;
        Object.defineProperty(transaction, 'oncomplete', { set(handler) {
          complete.set.call(transaction, event => { window.releaseAccountCompletion = () => handler(event); });
        } });
      }
      return get.call(this, key);
    };
    IDBObjectStore.prototype.put = function (value, key) {
      if (boundary === 'defaults' && key === 'account:alice' && value.defaultSettings && !held) {
        held = true;
        const transaction = this.transaction, handler = transaction.oncomplete;
        transaction.oncomplete = event => { window.releaseAccountCompletion = () => handler(event); };
      }
      return put.call(this, value, key);
    };
  }, boundary);
  const queued = (await local(page)).queue;
  includeDefaults = boundary === 'defaults';
  await page.locator('#sync').click();
  await page.waitForFunction(() => !!window.releaseAccountCompletion);
  await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=21');
    await store.transact(null, session => { session.activeProfile = store.LOCAL_PROFILE; session.paused = true; });
    const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close();
  });
  await deviceLocal(page);
  assert.equal(await page.locator('#captureText').inputValue(), 'Device-only draft');
  await page.evaluate(() => releaseAccountCompletion());
  // This error identifies the resumed old sync's completion; the pre-existing
  // local profile alone would not prove the stale continuation finished.
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Account changed while'));
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await deviceLocal(page);
  assert.doesNotMatch(await page.locator('#items').textContent(), /Alice private task|Alice pending task/);
  assert.equal(await page.locator('#captureText').inputValue(), 'Device-only draft');
  const saved = await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=21');
    return { session: await store.transact(null), alice: await store.transact('alice') };
  });
  assert.equal(saved.session.activeProfile, 'device-local'); assert.equal(saved.session.paused, true);
  assert.equal(saved.alice.records['item:private'].title, 'Alice private task');
  assert.deepEqual(saved.alice.queue, queued);
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
    assert.equal(await page.locator('#extractionStatus').isVisible(), expected === 'unavailable' || !!mode.checkFail);
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
  assert.equal(await page.locator('#extractionStatus').isVisible(), true);
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
  await page.evaluate(async () => { aiMode.state = 'available'; await (await import('/local-agent.js?v=2')).checkModel(); });
  await agentStatus(page, 'available');
  assert.deepEqual(await robot.boundingBox(), unavailableBounds);
  assert.equal(await page.locator('.agent-unavailable').isVisible(), false);
});

test('header prepares the model from a keyboard gesture, ignores duplicate clicks and stale availability, then enables capture', async t => {
  const { page, url } = await setup(t, 'alice', { state: 'downloadable', holdCreate: true });
  await page.goto(url); await status(page, 'confirmed'); await agentStatus(page, 'downloadable');
  await page.evaluate(() => {
    aiMode.holdCheck = true;
    void import('/local-agent.js?v=2').then(agent => agent.checkModel());
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
  assert.equal(await page.locator('#captureText').getAttribute('placeholder'), 'Get it out of your head.');
  assert.equal(await page.locator('#captureHelp').getAttribute('class'), 'sr-only');
  assert.equal(await page.locator('#captureHelp').textContent(), 'One item per line. For comma- or semicolon-separated items, choose Preview comma / semicolon split before saving. Ctrl/⌘ + Enter saves.');
  assert.equal(await page.locator('#captureText').getAttribute('aria-describedby'), 'captureHelp captureCompletionHint previewHelp');
  assert.equal(await page.locator('#previewSplit svg').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#previewSplit .split-label').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#previewSplit .split-label').isHidden(), true);
  assert.deepEqual(await page.locator('#previewSplit path').evaluateAll(paths => paths.map(path => ({ d: path.getAttribute('d'), dash: path.getAttribute('stroke-dasharray') }))), [
    { d: 'M8.7 8.7 21 21', dash: null },
    { d: 'm8.7 15.3 4.6-4.6', dash: null },
    { d: 'M12.3 12.3 21 3', dash: null },
    { d: 'M12 12H21', dash: '1 3' }
  ]);
  assert.deepEqual(await page.locator('.capture-header button:visible').evaluateAll(buttons => buttons.map(button => button.innerText)), ['', '']);
  assert.equal(await page.locator('#extractCloudStart').isVisible(), false);
  assert.ok((await page.getByRole('button', { name: 'Save on device', exact: true }).boundingBox()).y < (await page.locator('#captureText').boundingBox()).y);
  await clickControl(page.locator('#manageWorkspaces'));
  await page.locator('#createWorkspace input').fill('Family');
  await page.locator('#createWorkspace button').click();
  await page.getByRole('button', { name: 'Rename workspace: Family', exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click();
  await page.locator('#menuBack').click();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Family' });
  await page.waitForFunction(() => document.title === 'Capture · Family');
  await status(page, 'confirmed');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const heading = await page.locator('#captureHeading').boundingBox();
    const save = await page.getByRole('button', { name: 'Save on device', exact: true }).boundingBox();
    const text = await page.locator('#captureText').boundingBox();
    assert.ok(heading.width > 1 && heading.height > 1, 'Capture heading must be visually rendered');
    assert.equal(heading.x, text.x, 'Capture heading aligns with the textarea');
    assert.ok(heading.x + heading.width < save.x, 'Save stays to the right of the heading');
    assert.ok(heading.y + heading.height < text.y, 'Capture heading stays above the textarea');
    await shot(page, `capture-${width}`);
  }
  await page.locator('#captureText').fill('Family errands, call Sam');
  assert.equal(await page.locator('#previewSplit .split-label').isVisible(), true);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Personal' });
  await page.waitForFunction(() => document.title === 'Capture · Personal');
  assert.equal(await page.locator('#previewSplit .split-label').isHidden(), true);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption({ label: 'Family' });
  await page.waitForFunction(() => document.title === 'Capture · Family');
  assert.equal(await page.locator('#captureText').inputValue(), 'Family errands, call Sam');
  assert.equal(await page.locator('#previewSplit .split-label').isVisible(), true);
  await page.locator('#captureText').fill('');
  assert.equal(await page.locator('#previewSplit .split-label').isHidden(), true);
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
  // Expiry hides the previous identity, opens the local profile and preserves its unsent work.
  await context.setOffline(true);
  await page.locator('#captureText').fill('Keep pending task');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  const queued = (await local(page)).queue;
  assert.equal(queued.length, 1);
  setUser(null); await context.setOffline(false);
  await deviceLocal(page);
  assert.equal(await page.locator('#error').isVisible(), false);
  assert.equal(await page.locator('#saveStatus').isVisible(), true);
  assert.deepEqual((await local(page)).queue, queued);
});

test('sign-out in another tab clears a utility route and opens the local profile, then login restores it', async t => {
  const { page, context, url, setUser } = await setup(t, 'alice');
  await page.route('**/.auth/logout?**', route => route.fulfill({ status: 204 }));
  await page.goto(url); await status(page, 'confirmed');
  const second = await context.newPage();
  await second.goto(url); await status(second, 'confirmed');
  await openUtility(second, 'data-recovery/export');
  await second.locator('#exportHeading').waitFor();
  setUser(null);
  await clickControl(page.locator('#signOut'));
  await deviceLocal(page); await deviceLocal(second);
  // A previously opened utility route must also be cleared when the session ends.
  assert.equal(new URL(second.url()).hash, '#capture');
  assert.equal(await second.locator('#menuView').isVisible(), false);
  setUser('alice');
  await page.reload(); await status(page, 'confirmed');
  assert.equal(await page.locator('#appHeader').isVisible(), true);
  assert.equal(await page.locator('#agentStatus').isVisible(), true);
  assert.equal(await page.locator('#signedOut').isVisible(), false);
  assert.equal(await page.title(), 'Capture · Personal');
});
