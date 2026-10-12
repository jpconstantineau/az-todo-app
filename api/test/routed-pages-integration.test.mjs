import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import {
  clickControl,
  openAccountTaskOption,
  openClarificationPreferences,
  openListTaskOption,
  openMenu,
  openPreference,
  openUtility,
  showView,
} from './navigation-helper.mjs';

const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;
const viewports = [
  [320, 568], [390, 844], [768, 1024], [1024, 768],
  [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160],
];
const breakpointWidths = [599, 600, 1023, 1024, 1599, 1600];

async function setup(t) {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user });
  t.after(server.close);
  const browser = await chromium.launch({ channel });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url);
  await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#connectionLabel').textContent === 'Saved to cloud');
  return { browser, context, page, server, setUser(value) { user = value; } };
}

async function localSnapshot(page) {
  return page.evaluate(async () => {
    const local = await (await import('/inbox-store.js?v=17')).transact('alice');
    return structuredClone({ draft: local.draft, preferenceDraft: local.preferenceDraft, queue: local.queue });
  });
}

async function createList(page, title) {
  await showView(page, 'lists');
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await page.locator('#edit [name=title]').fill(title);
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
}

async function actionInventory(page, selector) {
  return page.locator(`${selector} a:visible, ${selector} button:visible, ${selector} select:visible, ${selector} textarea:visible, ${selector} input:visible`)
    .evaluateAll(elements => elements.filter(element => !element.closest('.menu-page-bar')).map(element => ({
      tag: element.tagName,
      id: element.id,
      name: element.getAttribute('aria-label') || element.textContent.trim() || element.getAttribute('name') || element.type,
    })));
}

async function assertRoutedComposition(page, spec, width) {
  assert.equal(new URL(page.url()).hash, spec.route);
  assert.equal(await page.locator(`${spec.surface} h1:visible`).count(), 1, `${spec.route} has one visible route heading at ${width}px`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${spec.route} has no horizontal page scroll at ${width}px`);
  assert.equal(await page.locator(`${spec.surface} dialog`).count(), 0, `${spec.route} is not a dialog surface`);

  const detail = await page.locator(spec.detail).boundingBox();
  assert.ok(detail.width <= spec.cap, `${spec.route} detail stays within ${spec.cap}px at ${width}px`);
  if (spec.master) {
    const master = page.locator(spec.master);
    assert.equal(await master.isVisible(), width >= 1024, `${spec.route} master visibility follows the 1024px threshold`);
    if (width >= 1024) {
      const masterBox = await master.boundingBox();
      assert.equal(Math.round(masterBox.width), spec.masterWidth);
      assert.ok(masterBox.x < detail.x, `${spec.route} master precedes its detail geometrically`);
      assert.equal(await master.evaluate((element, detailSelector) =>
        !!(element.compareDocumentPosition(document.querySelector(detailSelector)) & Node.DOCUMENT_POSITION_FOLLOWING), spec.detail), true,
      `${spec.route} master precedes its detail in the DOM`);
    }
  }
  if (width >= 1600) {
    const shell = await page.locator(spec.surface).boundingBox();
    assert.ok(shell.width <= 1440, `${spec.route} app surface is capped at 1440px`);
  }

  const nestedScrollers = await page.locator(spec.surface).evaluate((surface, detailSelector) => {
    const detail = surface.querySelector(detailSelector) || document.querySelector(detailSelector);
    return [...detail.querySelectorAll('section, nav, div, ol, ul')].filter(element => {
      const overflow = getComputedStyle(element).overflowY;
      return ['auto', 'scroll'].includes(overflow) && element.scrollHeight > element.clientHeight + 1;
    }).map(element => element.id || element.className);
  }, spec.detail);
  assert.deepEqual(nestedScrollers, [], `${spec.route} does not introduce a nested vertical sheet scroller`);

  const routeTargets = page.locator(`${spec.surface} .menu-row:visible, ${spec.surface} .menu-page-bar button:visible, ${spec.surface} .clarify-action-order button:visible`);
  for (const target of await routeTargets.all()) assert.ok((await target.boundingBox()).height >= 48, `${spec.route} routed targets stay at least 48px high`);
  const controls = page.locator(`${spec.detail} button:visible, ${spec.detail} select:visible, ${spec.detail} textarea:visible, ${spec.detail} input:not([type=checkbox]):not([type=radio]):visible`);
  for (const control of await controls.all()) assert.ok((await control.boundingBox()).height >= 44, `${spec.route} controls stay at least 44px high`);
}

test('routed pages hold one responsive accessible composition across themes, breakpoints and emulated reflow', { timeout: 180000 }, async t => {
  const { page } = await setup(t);
  await createList(page, 'Integration list');

  const routes = [
    { route: '#menu', surface: '#menuView', detail: '.menu-master', cap: 720, open: () => openMenu(page) },
    { route: '#preferences/appearance', surface: '#preferencesView', detail: '#preferencesAppearance', cap: 760,
      master: '#preferencesNav', masterWidth: 280, open: () => openPreference(page, 'appearance') },
    { route: '#preferences/process/clarify-actions/add', surface: '#preferencesView', detail: '#clarifyActionEditorPanel', cap: 720,
      master: '#clarifyActionMaster', masterWidth: 320, open: async () => {
        await openClarificationPreferences(page);
        await page.locator('#addClarifyAction').click();
        await page.waitForFunction(() => location.hash === '#preferences/process/clarify-actions/add');
      } },
    { route: '#preferences/task-options/contexts', surface: '#taskOptionsView', detail: '#taskOptionEditor', cap: 720,
      master: '#taskOptionsMaster', masterWidth: 280, open: () => openAccountTaskOption(page, 'contexts') },
    { route: null, surface: '#taskOptionsView', detail: '#taskOptionEditor', cap: 720,
      master: '#taskOptionsMaster', masterWidth: 280, open: async () => {
        await openListTaskOption(page, 'Integration list', 'contexts');
        routes[4].route = new URL(page.url()).hash;
      } },
    { route: '#app-device/updates', surface: '#utilityView', detail: '#appDeviceUpdates', cap: 760,
      master: '#utilityMaster', masterWidth: 280, open: () => openUtility(page, 'app-device/updates') },
    { route: '#data-recovery/export', surface: '#utilityView', detail: '#dataRecoveryExport', cap: 760,
      master: '#utilityMaster', masterWidth: 280, open: () => openUtility(page, 'data-recovery/export') },
  ];

  for (const spec of routes) {
    await spec.open();
    let inventory;
    for (const width of breakpointWidths) {
      await page.setViewportSize({ width, height: 900 });
      await assertRoutedComposition(page, spec, width);
      const current = await actionInventory(page, spec.detail);
      inventory ??= current;
      assert.deepEqual(current, inventory, `${spec.route} keeps its detail actions at ${width}px`);
    }
  }

  for (const theme of ['dark', 'light']) {
    await openPreference(page, 'appearance');
    await page.locator('[data-appearance]').selectOption(theme);
    await openAccountTaskOption(page, 'contexts');
    await page.locator('#taskOptionValue').focus();
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height });
      await assertRoutedComposition(page, routes[3], width);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.equal(await page.locator('#taskOptionValue').evaluate(element => element === document.activeElement), true);
    }
  }

  // Device metrics provide deterministic CSS viewport evidence for 1280px at
  // 400% and 1920/2560px at 200%; this is not physical browser-zoom evidence.
  for (const [width, expectedMaster] of [[320, false], [960, false], [1280, true]]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('#taskOptionsMaster').isVisible(), expectedMaster);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200% root text keeps 400% reflow free of horizontal scroll');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ forcedColors: 'active' });
  assert.equal(await page.locator('#task-option-contexts').getAttribute('aria-current'), 'page');
  assert.notEqual(await page.locator('#task-option-contexts').evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  await page.locator('#taskOptionValue').focus();
  assert.equal(await page.locator('#taskOptionValue').evaluate(element => element.matches(':focus-visible')), true);
  assert.equal(await page.locator('#taskOptionValue').evaluate(element => getComputedStyle(element).outlineWidth), '3px');
  await page.emulateMedia({ forcedColors: 'none' });
});

test('route navigation, threshold resizing, history, offline reload and touch keep exact pending work', { timeout: 180000 }, async t => {
  const { browser, context, page, server } = await setup(t);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.locator('#captureText').fill('Queued integration operation');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.locator('#captureText').fill('Unsaved integration draft');
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=17')).transact('alice');
    return local.queue.length === 1 && local.queue[0].operation.mutations[0].fields.title === 'Queued integration operation'
      && local.draft.capture.text === 'Unsaved integration draft';
  });
  await showView(page, 'work');
  await page.evaluate(() => { document.body.style.minHeight = '2500px'; scrollTo(0, 500); });
  await page.waitForFunction(() => scrollY === 500);

  await page.locator('#appMenu').evaluate(element => element.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#menu' && document.activeElement?.id === 'menuHeading');
  await page.locator('#openPreferences').click();
  await page.waitForFunction(() => location.hash === '#preferences' && document.activeElement?.id === 'preferencesHeading');
  await page.locator('#preference-task-options').click();
  await page.waitForFunction(() => location.hash === '#preferences/task-options' && document.activeElement?.id === 'taskOptionsMasterHeading');
  await page.locator('#task-option-contexts').click();
  await page.waitForFunction(() => location.hash === '#preferences/task-options/contexts' && document.activeElement?.id === 'taskOptionHeading');
  await page.locator('#taskOptionValue').fill('@Integration draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=17')).transact('alice')).preferenceDraft?.defaults?.values.contexts === '@Integration draft');
  await page.locator('#taskOptionValue').focus();
  const beforeResize = await localSnapshot(page);

  for (const width of [1024, 1600, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(new URL(page.url()).hash, '#preferences/task-options/contexts');
    assert.equal(await page.locator('#taskOptionValue').inputValue(), '@Integration draft');
    assert.equal(await page.locator('#taskOptionValue').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#task-option-contexts').getAttribute('aria-current'), 'page');
    assert.deepEqual(await localSnapshot(page), beforeResize);
  }

  for (const [route, focus] of [
    ['#preferences/task-options', 'task-option-contexts'],
    ['#preferences', 'preference-task-options'],
    ['#menu', 'openPreferences'],
    ['#work', 'appMenu'],
  ]) {
    await page.goBack();
    await page.waitForFunction(({ route, focus }) => location.hash === route && document.activeElement?.id === focus, { route, focus });
  }
  await page.waitForFunction(() => scrollY === 500);
  assert.equal(await page.locator('#captureText').inputValue(), 'Unsaved integration draft');
  for (const route of ['#menu', '#preferences', '#preferences/task-options', '#preferences/task-options/contexts']) {
    await page.goForward();
    await page.waitForFunction(route => location.hash === route, route);
  }
  await page.waitForFunction(() => document.activeElement?.id === 'taskOptionHeading');
  assert.deepEqual(await localSnapshot(page), beforeResize);

  await page.reload();
  await page.locator('#taskOptionHeading').waitFor();
  assert.equal(await page.locator('#taskOptionValue').inputValue(), '@Integration draft');
  assert.deepEqual(await localSnapshot(page), beforeResize);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=17')).transact('alice');
    return local.queue.length === 2 && local.preferenceDraft?.defaults === null;
  });
  const queued = (await localSnapshot(page)).queue;
  assert.equal(new Set(queued.map(entry => entry.operation.operationId)).size, 2);

  await context.setOffline(false);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Sync now' }));
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=17')).transact('alice');
    return local.queue.length === 0 && local.records['settings:settings']?.defaults?.contexts?.includes('@Integration draft');
  });
  for (const entry of queued) assert.equal(documents.filter(document => document.id === `receipt:${entry.operation.operationId}`).length, 1);
  assert.equal(documents.filter(document => document.record?.type === 'item' && document.record.title === 'Queued integration operation').length, 1);

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  t.after(() => touch.close());
  const touchPage = await touch.newPage();
  await touchPage.goto(server.url);
  await touchPage.locator('#workspace').waitFor();
  await touchPage.locator('#appMenu').tap();
  await touchPage.waitForFunction(() => location.hash === '#menu');
  await touchPage.locator('#openPreferences').tap();
  await touchPage.waitForFunction(() => location.hash === '#preferences');
  assert.deepEqual(await touchPage.locator('#preferencesCategories .menu-row > span:first-child').allTextContents(),
    ['Appearance', 'Capture', 'Process', 'Task options']);
  assert.ok(await touchPage.locator('#preferencesCategories .menu-row').evaluateAll(rows => rows.every(row => row.getBoundingClientRect().height >= 48)));
});

test('direct routed families reload, fall back safely and clear account-owned route state on account change', { timeout: 120000 }, async t => {
  const { page, server, setUser } = await setup(t);
  await createList(page, 'Direct route list');
  const listId = await page.evaluate(async () => {
    const local = await (await import('/inbox-store.js?v=17')).transact('alice');
    return Object.values(local.records).find(record => record.type === 'list' && record.title === 'Direct route list').id;
  });
  const directRoutes = [
    ['#preferences/appearance', '#preferencesAppearanceHeading'],
    ['#preferences/process/clarify-actions', '#clarifyActionsHeading'],
    ['#preferences/process/clarify-actions/add', '#clarifyActionEditorHeading'],
    ['#preferences/task-options/contexts', '#taskOptionHeading'],
    [`#lists/${listId}/task-options/contexts`, '#taskOptionHeading'],
    ['#app-device/updates', '#updatesHeading'],
    ['#data-recovery/export', '#exportHeading'],
    ['#data-recovery/restore-from-cloud/review', '#resetReviewHeading'],
  ];
  const back = '#taskOptionEditorBack:visible, #taskOptionsMasterBack:visible, #clarifyActionEditorBack:visible, #clarifyActionsBack:visible, .preferences-detail:not([hidden]) .preference-back:visible, #preferencesBack:visible, .utility-page:not([hidden]) .utility-back:visible, #utilityMasterBack:visible, #utilityHubBack:visible';

  for (const [route, heading] of directRoutes) {
    await page.goto(server.url + route);
    await page.waitForFunction(({ route, heading }) => location.hash === route && document.querySelector(heading) === document.activeElement,
      { route, heading });
    await page.reload();
    await page.waitForFunction(({ route, heading }) => location.hash === route && document.querySelector(heading) === document.activeElement,
      { route, heading });
    assert.equal(await page.locator('h1:visible').count(), 1);
    for (let step = 0; step < 4 && new URL(page.url()).hash !== '#capture'; step++) {
      const previous = new URL(page.url()).hash;
      await page.locator(back).first().click();
      await page.waitForFunction(previous => location.hash !== previous, previous);
    }
    assert.equal(new URL(page.url()).hash, '#capture', `${route} Back chain has a safe Capture fallback`);
  }

  await page.goto(server.url + '#not-a-route');
  await page.waitForFunction(() => location.hash === '#capture' && document.activeElement?.id === 'captureText');

  await openPreference(page, 'appearance');
  await page.locator('[data-appearance]').selectOption('light');
  await openAccountTaskOption(page, 'contexts');
  await page.locator('#taskOptionValue').fill('@Alice only');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=17')).transact('alice')).preferenceDraft?.defaults?.values.contexts === '@Alice only');
  setUser('bob');
  await page.locator('#sync').evaluate(button => button.click());
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=17')).transact(null)).accountId === 'bob');
  await page.waitForFunction(() => location.hash === '#capture' && !document.querySelector('#workspace').hidden);
  assert.equal(await page.locator('#taskOptionsView').isVisible(), false);
  assert.equal((await page.locator('#taskOptionValue').inputValue()).includes('@Alice only'), false);
  assert.equal((await page.evaluate(async () => (await import('/inbox-store.js?v=17')).transact('bob'))).preferenceDraft?.defaults, undefined);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'browser-local appearance survives account change');
});
