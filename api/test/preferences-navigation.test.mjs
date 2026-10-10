import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { openAccountTaskOption, openClarificationPreferences, openListTaskOption, openPreference, openPreferences, showView } from './navigation-helper.mjs';

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
  assert.deepEqual(await page.locator('#preferencesCategories > li > a > span:first-child').allTextContents(), ['Appearance', 'Capture', 'Process', 'Task options']);
  assert.equal(await page.locator('#preferencesView').getByText(/Organize|Plan|Do|Review/, { exact: true }).count(), 0);
  assert.equal(await page.locator('#preferencesView').getByText(/Install|update|reset/i).count(), 0);
  assert.deepEqual(await page.locator('#preferencesCategories .menu-row-value').allTextContents(), ['Dark · Browser', 'Off · Browser', '12 actions · Browser', 'Account']);

  await openPreference(page, 'appearance');
  assert.equal(new URL(page.url()).hash, '#preferences/appearance');
  assert.equal(await page.title(), 'Appearance · Personal');
  assert.equal(await page.locator('h1:visible').count(), 1);
  assert.equal(await page.locator('#preferencesAppearanceHeading').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('#preference-appearance').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#preferencesAppearance select[data-appearance]').count(), 1);
  assert.equal(await page.locator('#preferencesAppearance dialog').count(), 0);
  assert.deepEqual(await page.locator('#preferencesAppearance p').allTextContents(), ['Browser']);
  const theme = page.locator('#preferencesAppearance [data-appearance]');
  await theme.selectOption('light');
  assert.equal(await page.locator('#preference-appearance-summary').textContent(), 'Light · Browser');
  assert.equal(await page.evaluate(() => localStorage.getItem('todo-appearance')), 'light');
  await theme.focus();

  for (const [width, height] of [[320, 568], [390, 844], [600, 900], [768, 1024], [1024, 768], [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    await page.setViewportSize({ width, height });
    assert.equal(new URL(page.url()).hash, '#preferences/appearance');
    assert.equal(await theme.evaluate(element => element === document.activeElement), true);
    assert.equal(await theme.inputValue(), 'light');
    assert.equal(await page.locator('#preference-appearance').getAttribute('aria-current'), 'page');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px has no horizontal overflow`);
    assert.equal(await page.locator('#preferencesNav').isVisible(), width >= 1024);
    if (width >= 1024) assert.equal(Math.round((await page.locator('#preferencesNav').boundingBox()).width), 280);
    const control = await theme.boundingBox();
    assert.ok(control.height >= 48, `${width}px Theme is at least 48px high`);
    if (width < 600) {
      const detail = await page.locator('#preferencesAppearance').boundingBox();
      assert.ok(Math.abs(control.width - detail.width) <= 1, `${width}px Theme fills the detail column`);
    } else assert.ok(control.width <= 384, `${width}px Theme keeps its readable width cap`);
    if (width === 600) {
      const shell = await page.locator('#preferencesView').boundingBox();
      assert.equal(Math.round(shell.x), 24);
      assert.equal(Math.round(width - shell.x - shell.width), 24);
    }
    assert.ok(await page.locator('.preferences-detail:visible .menu-page-bar').evaluate(element => element.getBoundingClientRect().height >= 48));
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await theme.evaluate(element => element === document.activeElement), true);
  assert.ok((await theme.boundingBox()).height >= 48);
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  const afterResize = await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'));
  assert.deepEqual(afterResize.queue, before.queue);
  assert.equal(afterResize.draft.capture.text, before.draft.capture.text);
  await page.locator('.preferences-detail:visible .preference-back').click();
  await page.waitForFunction(() => location.hash === '#preferences' && document.activeElement?.id === 'preference-appearance');

  await page.goto(server.url + '#preferences/process'); await page.locator('#preferencesProcessHeading').waitFor();
  assert.equal(await page.locator('#preferencesProcessHeading').evaluate(element => element === document.activeElement), true);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator('#preference-appearance').click();
  await page.waitForFunction(() => location.hash === '#preferences/appearance');
  await page.locator('.preferences-detail:visible .preference-back').click();
  await page.waitForFunction(() => location.hash === '#capture');
  await page.goto(server.url + '#preferences'); await page.locator('#preferencesHeading').waitFor();
  assert.equal(new URL(page.url()).hash, '#preferences');
  await context.setOffline(false);
  await page.goto(server.url + '#preferences/capture'); await page.waitForFunction(() => location.hash === '#preferences/capture' && document.activeElement?.id === 'preferencesCaptureHeading');
  assert.equal(await page.locator('#captureCloudAI').isVisible(), true);
  assert.equal(await page.locator('#captureCloudAI').isChecked(), false);
  assert.match(await page.locator('#captureCloudAIHelp').textContent(), /signed in and online.*sends nothing.*Only pressing.*list names/s);
  assert.equal(await page.locator('#preferencesCapture .preference-scope').textContent(), 'Browser');
});

test('Clarify action pages keep ordered browser settings, explicit drafts, focus and responsive routes', { timeout: 90000 }, async t => {
  const { page, context, server } = await setup(t);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  const taskState = () => page.evaluate(async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return { records: local.records, queue: local.queue, preferenceDraft: local.preferenceDraft };
  });
  const before = await taskState();
  await openClarificationPreferences(page);
  assert.equal(await page.title(), 'Clarify actions · Personal');
  assert.equal(await page.locator('h1:visible').count(), 1);
  assert.deepEqual(await page.locator('#clarifyPrimaryActions .clarify-action-link > span:first-child').allTextContents(),
    ['Make project', 'Make list', 'Make checklist', 'Action', 'Reference', 'Someday']);
  assert.equal(await page.locator('.clarify-action-behavior').count(), 0);
  const move = page.getByRole('button', { name: 'Move Make project down in Primary' });
  await move.focus(); await move.press('Enter');
  await page.waitForFunction(() => document.querySelector('#clarifyPrimaryActions .clarify-action-link span').textContent === 'Make list');
  assert.equal(await move.evaluate(element => element === document.activeElement), true);

  await page.locator('#addClarifyAction').click();
  await page.waitForFunction(() => location.hash === '#preferences/process/clarify-actions/add' && document.activeElement?.id === 'clarifyActionEditorHeading');
  const form = page.locator('#clarifyActionEditor');
  await form.locator('[name=label]').fill('Make shopping list');
  await form.locator('[name=behavior]').selectOption('make-checklist');
  await form.locator('[name=placement]').selectOption('more');
  await form.locator('[name=position]').selectOption('2');
  await page.waitForFunction(() => document.querySelector('#clarifyActionEditorStatus').textContent.includes('Draft saved'));
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await form.locator('[name=label]').inputValue(), 'Make shopping list');
  assert.equal(await form.locator('[name=placement]').inputValue(), 'more');
  assert.equal(await form.locator('[name=position]').inputValue(), '2');
  assert.equal(await page.locator('#clarifyActionEditorStatus').textContent(), 'Draft restored for this tab.');

  for (const [width, height] of [[320, 568], [390, 844], [600, 900], [768, 1024], [1024, 768], [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    await page.setViewportSize({ width, height });
    assert.equal(new URL(page.url()).hash, '#preferences/process/clarify-actions/add');
    assert.equal(await form.locator('[name=label]').inputValue(), 'Make shopping list');
    assert.equal(await page.locator('h1:visible').count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px has no horizontal overflow`);
    assert.equal(await page.locator('#clarifyActionMaster').isVisible(), width >= 1024);
    assert.equal(await page.locator('#clarifyActionEditorPanel').isVisible(), true);
    if (width >= 1024) assert.equal(Math.round((await page.locator('#clarifyActionMaster').boundingBox()).width), 320);
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await form.locator('[name=label]').inputValue(), 'Make shopping list');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#preferences/process/clarify-actions/edit/'));
  const customRoute = new URL(page.url()).hash;
  assert.equal(await page.title(), 'Edit Clarify action · Personal');
  assert.equal(await form.locator('[name=label]').inputValue(), 'Make shopping list');
  assert.equal(await page.locator('.clarify-action-link[aria-current=page]').count(), 1);
  await page.locator('#clarifyActionEditorBack').click();
  await page.waitForFunction(() => location.hash === '#preferences/process/clarify-actions');
  assert.deepEqual((await page.locator('#clarifyMoreActions .clarify-action-link > span:first-child').allTextContents()).slice(0, 3),
    ['Make area', 'Make shopping list', 'Make role']);
  assert.equal(await page.locator('#clarifyMoreActions .clarify-action-behavior').filter({ hasText: 'Make checklist' }).count(), 1);
  await page.goBack(); await page.waitForFunction(() => location.hash === '#preferences/process');
  await page.goForward(); await page.waitForFunction(() => location.hash === '#preferences/process/clarify-actions');
  await page.goto(server.url + customRoute); await page.locator('#clarifyActionEditorHeading').waitFor();
  assert.equal(await page.locator('#clarifyActionEditorHeading').evaluate(element => element === document.activeElement), true);
  await page.setViewportSize({ width: 1366, height: 768 });
  const moveCustom = page.getByRole('button', { name: 'Move Make shopping list up in More' });
  await moveCustom.focus(); await moveCustom.press('Enter');
  await page.waitForFunction(() => document.querySelector('#clarifyMoreActions .clarify-action-link span')?.textContent === 'Make shopping list');
  await page.waitForFunction(() => document.activeElement?.dataset.focusKey?.endsWith(':edit'));
  assert.equal(await page.locator('.clarify-action-link[aria-current=page]').evaluate(element => element === document.activeElement), true);
  assert.equal(await form.locator('[name=position]').inputValue(), '1');
  await page.emulateMedia({ forcedColors: 'active' });
  assert.notEqual(await page.locator('.clarify-action-link[aria-current=page]').evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  await page.emulateMedia({ forcedColors: 'none' });

  const storedBeforeFailure = await page.evaluate(() => localStorage.getItem('todo-clarification-actions'));
  await page.evaluate(() => {
    window.__clarifySetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === 'todo-clarification-actions') throw new Error('full');
      return window.__clarifySetItem.call(this, key, value);
    };
  });
  await form.locator('[name=label]').fill('Unsaved shopping alias');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  assert.match(await page.locator('#clarifyActionError').textContent(), /Nothing changed/);
  assert.equal(await page.evaluate(() => localStorage.getItem('todo-clarification-actions')), storedBeforeFailure);
  await page.evaluate(() => { Storage.prototype.setItem = window.__clarifySetItem; });
  await page.locator('#discardClarifyActionDraft').click();
  assert.equal(await form.locator('[name=label]').inputValue(), 'Make shopping list');
  assert.equal(await form.locator('[name=label]').evaluate(element => element === document.activeElement), true);

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('button', { name: 'Move Make project down in Primary' }).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.activeElement?.id === 'clarifyActionEditorHeading');
  await context.setOffline(true); await page.reload(); await page.locator('#clarifyActionEditorHeading').waitFor();
  assert.equal(new URL(page.url()).hash, customRoute);
  assert.equal(await form.locator('[name=label]').inputValue(), 'Make shopping list');
  await context.setOffline(false);

  await page.locator('#removeClarifyAction').click();
  await page.waitForFunction(route => location.hash !== route && document.activeElement?.id === 'clarifyActionEditorHeading', customRoute);
  assert.equal(await page.getByText('Make shopping list', { exact: true }).count(), 0);
  await page.locator('#clarifyActionEditorBack').click();
  await page.waitForFunction(() => location.hash === '#preferences/process/clarify-actions' && document.activeElement?.id === 'clarifyActionsHeading');
  await page.goto(server.url + customRoute);
  await page.waitForFunction(() => location.hash === '#preferences/process/clarify-actions' && document.activeElement?.id === 'clarifyActionsHeading');
  await page.locator('#resetClarifyActions').click();
  assert.equal(await page.locator('#restoreClarifyConfirmation').isVisible(), true);
  await page.locator('#cancelResetClarifyActions').click();
  assert.equal(await page.locator('#resetClarifyActions').evaluate(element => element === document.activeElement), true);
  await page.locator('#resetClarifyActions').click(); await page.locator('#confirmResetClarifyActions').click();
  await page.waitForFunction(() => location.hash.endsWith('/edit/project') && document.activeElement?.id === 'clarifyActionEditorHeading');
  assert.equal(await form.locator('[name=label]').inputValue(), 'Make project');
  assert.deepEqual(await taskState(), before);
});

test('Clarify action drafts isolate tabs and block overwriting a newer browser setting', { timeout: 90000 }, async t => {
  const { page, context, server } = await setup(t);
  const other = await context.newPage(); await other.goto(server.url); await other.locator('#workspace').waitFor();
  const before = await page.evaluate(async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return { records: local.records, queue: local.queue, preferenceDraft: local.preferenceDraft };
  });
  await openClarificationPreferences(page); await openClarificationPreferences(other);
  await page.locator('#clarify-action-project').click(); await other.locator('#clarify-action-project').click();
  const editor = page.locator('#clarifyActionEditor'), otherEditor = other.locator('#clarifyActionEditor');
  await editor.locator('[name=label]').fill('My unfinished project label');
  await otherEditor.locator('[name=label]').fill('Project from another tab');
  await otherEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyActionError').textContent.includes('changed in another tab'));
  assert.equal(await editor.locator('[name=label]').inputValue(), 'My unfinished project label');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  assert.match(await page.locator('#clarifyActionError').textContent(), /changed or was removed/);
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('todo-clarification-actions'))).actions.find(entry => entry.id === 'project').label, 'Project from another tab');
  await page.locator('#discardClarifyActionDraft').click();
  assert.equal(await editor.locator('[name=label]').inputValue(), 'Project from another tab');
  await otherEditor.locator('[name=label]').fill('Latest clean project label');
  await otherEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyActionEditor [name=label]').value === 'Latest clean project label');

  await page.locator('#clarifyActionEditorBack').click(); await page.waitForFunction(() => location.hash === '#preferences/process/clarify-actions');
  await page.locator('#addClarifyAction').click();
  await page.evaluate(() => {
    window.__clarifySessionSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === sessionStorage && key.startsWith('todo-clarification-action-draft:')) throw new Error('full');
      return window.__clarifySessionSetItem.call(this, key, value);
    };
  });
  await page.locator('#clarifyActionEditor [name=label]').fill('Live only');
  assert.match(await page.locator('#clarifyActionEditorStatus').textContent(), /cannot survive reload/);
  assert.equal(await page.locator('#clarifyActionEditor [name=label]').inputValue(), 'Live only');
  await page.evaluate(() => { Storage.prototype.setItem = window.__clarifySessionSetItem; });
  const after = await page.evaluate(async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return { records: local.records, queue: local.queue, preferenceDraft: local.preferenceDraft };
  });
  assert.deepEqual(after, before);
});

test('Appearance storage updates every tab and visible summary without native change echoes', { timeout: 90000 }, async t => {
  const { page, context, server } = await setup(t);
  const other = await context.newPage();
  await other.goto(server.url); await other.locator('#workspace').waitFor();
  await openPreference(page, 'appearance');
  await openPreferences(other);
  await other.evaluate(() => {
    window.appearanceEvents = { storage: 0, applied: 0, native: 0 };
    addEventListener('storage', event => { if (event.key === 'todo-appearance' || event.key === null) appearanceEvents.storage++; });
    addEventListener('todo-appearance-change', () => appearanceEvents.applied++);
    document.addEventListener('change', event => { if (event.target.matches('[data-appearance]')) appearanceEvents.native++; });
  });
  const before = await page.evaluate(async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return { queue: local.queue, preferenceDraft: local.preferenceDraft };
  });

  for (const [value, label] of [['light', 'Light'], ['system', 'System'], ['dark', 'Dark']]) {
    await page.locator('[data-appearance]').selectOption(value);
    await other.waitForFunction(expected => document.documentElement.dataset.theme === expected &&
      document.querySelector('[data-appearance]').value === expected &&
      document.querySelector('#preference-appearance-summary').textContent === `${expected[0].toUpperCase()}${expected.slice(1)} · Browser`, value);
    assert.equal(await page.evaluate(() => localStorage.getItem('todo-appearance')), value);
    assert.equal(await other.locator('#preference-appearance-summary').textContent(), `${label} · Browser`);
  }
  await page.evaluate(() => localStorage.clear());
  await other.waitForFunction(() => document.documentElement.dataset.theme === 'dark' &&
    document.querySelector('[data-appearance]').value === 'dark' &&
    document.querySelector('#preference-appearance-summary').textContent === 'Dark · Browser');
  assert.deepEqual(await other.evaluate(() => appearanceEvents), { storage: 4, applied: 4, native: 0 });
  const after = await page.evaluate(async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return { queue: local.queue, preferenceDraft: local.preferenceDraft };
  });
  assert.deepEqual(after, before);
});

test('Task options use account draft storage while browser preferences stay browser-scoped', { timeout: 90000 }, async t => {
  const { page, context, setUser } = await setup(t);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await openPreference(page, 'appearance');
  await page.locator('[data-appearance]').selectOption('light');
  await openPreference(page, 'task-options');
  assert.equal(await page.locator('#taskOptionRows > li').count(), 6);
  assert.equal(await page.locator('#taskOptionsView dialog').count(), 0);
  await openAccountTaskOption(page, 'contexts');
  assert.equal(await page.locator('#taskOptionLabel').textContent(), 'Contexts — one per line');
  await page.locator('#taskOptionValue').fill('@Home\n@Draft');
  await page.locator('#taskOptionValue').focus();
  for (const width of [320, 390, 599, 600, 1023, 1024, 1920, 3840]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(new URL(page.url()).hash, '#preferences/task-options/contexts');
    assert.equal(await page.locator('#taskOptionValue').inputValue(), '@Home\n@Draft');
    assert.equal(await page.locator('#taskOptionValue').evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#taskOptionsMaster').isVisible(), width >= 1024);
    assert.ok((await page.locator('#taskOptionEditor').boundingBox()).width <= 720);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.locator('#taskOptionValue').inputValue(), '@Home\n@Draft');
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).preferenceDraft?.defaults?.values.contexts === '@Home\n@Draft');
  await page.reload(); await page.locator('#taskOptionHeading').waitFor();
  assert.equal(await page.locator('#taskOptionValue').inputValue(), '@Home\n@Draft');
  await context.setOffline(true);
  await page.locator('#defaultsForm [type=submit]').click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return local.queue.length === 1 && local.preferenceDraft?.defaults === null;
  });
  assert.equal(new URL(page.url()).hash, '#preferences/task-options/contexts');
  await page.locator('[data-appearance]').count();
  await context.setOffline(false);
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return local.queue.length === 0 && local.records['settings:settings']?.defaults?.contexts?.includes('@Draft');
  });
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  setUser('bob');
  await page.locator('#sync').evaluate(button => button.click());
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact(null)).accountId === 'bob');
  await page.waitForFunction(() => location.hash === '#capture' && !document.querySelector('#workspace').hidden && !document.querySelector('#workspaceSelect').hidden);
  assert.equal((await page.locator('#taskOptionValue').inputValue()).includes('@Draft'), false);
  assert.equal(await page.locator('#taskOptionsView').isVisible(), false);
  await openPreference(page, 'appearance');
  assert.equal(await page.locator('[data-appearance]').inputValue(), 'light');
  assert.equal((await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('bob'))).queue.length, 0);
  await showView(page, 'capture');
});

test('Task option stale drafts can be discarded for the latest record', async t => {
  const { page } = await setup(t);
  await openAccountTaskOption(page, 'contexts');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=15')).transact('alice');
    return local.queue.length === 0 && local.records['settings:settings']?.version === 1;
  });
  await page.locator('#taskOptionValue').fill('@Stale proposal');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).preferenceDraft?.defaults?.values.contexts === '@Stale proposal');
  await page.evaluate(async () => {
    const { transact } = await import('/inbox-store.js?v=15');
    await transact('alice', local => {
      const current = local.records['settings:settings'];
      local.records['settings:settings'] = { ...current, version: current.version + 1, defaults: { ...current.defaults, contexts: ['@Newer'] } };
    });
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#defaultsError').textContent.includes('Defaults changed while editing'));
  assert.equal((await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'))).queue.length, 0);
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).preferenceDraft?.defaults === null);
  assert.equal(await page.locator('#taskOptionValue').inputValue(), '@Newer');
  assert.equal(await page.locator('#defaultsError').isHidden(), true);
  assert.equal(await page.locator('#taskOptionStatus').textContent(), 'Draft discarded. Latest saved options restored.');
});

test('Task option draft status waits for its IndexedDB commit', async t => {
  const { page } = await setup(t);
  await openAccountTaskOption(page, 'contexts');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let failNextAccountWrite = true;
    IDBObjectStore.prototype.put = function () {
      if (this.name === 'accounts' && failNextAccountWrite) {
        failNextAccountWrite = false;
        throw new DOMException('Full', 'QuotaExceededError');
      }
      return original.apply(this, arguments);
    };
  });
  await page.locator('#taskOptionValue').fill('@Not saved');
  await page.locator('#recovery').waitFor();
  await page.waitForFunction(() => document.querySelector('#taskOptionStatus').textContent === 'Draft not saved on this device.');
  assert.match(await page.locator('#recoveryText').inputValue(), /@Not saved/);
  const local = await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'));
  assert.notEqual(local.preferenceDraft?.defaults?.values?.contexts, '@Not saved');
  assert.equal(local.queue.length, 0);
});

test('A moved list keeps its task-option draft recoverable without allowing a wrong-target save', async t => {
  const { page } = await setup(t);
  await showView(page, 'lists');
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await page.locator('#edit [name=title]').fill('Movable');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await openListTaskOption(page, 'Movable', 'contexts');
  await page.locator('#taskOptionValue').fill('@Keep me');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.defaults?.values.contexts === '@Keep me');
  await page.evaluate(async () => {
    const { transact } = await import('/inbox-store.js?v=15');
    await transact('alice', local => {
      const list = Object.values(local.records).find(record => record.type === 'list' && record.title === 'Movable');
      local.records[`list:${list.id}`] = { ...list, version: list.version + 1, workspaceId: 'another-workspace' };
    });
    const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close();
  });
  await page.waitForFunction(() => document.querySelector('#taskOptionScope').textContent.includes('no longer available in this workspace'));
  assert.equal(await page.locator('#taskOptionValue').inputValue(), '@Keep me');
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  const before = await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'));
  assert.equal(before.queue.length, 0);
  await page.locator('#taskOptionEditorBack').click(); await page.locator('#taskOptionsMasterBack').click();
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await page.locator('#edit [name=title]').fill('Other list');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.locator('#view').selectOption({ label: 'Other list' });
  await page.getByRole('button', { name: 'Task options: Other list', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('draft opened instead'));
  assert.match(new URL(page.url()).hash, /^#lists\/[A-Za-z0-9_-]+\/task-options$/);
  assert.match(await page.locator('#taskOptionsMasterHeading').textContent(), /Movable/);
  await page.locator('#task-option-contexts').click();
  assert.equal(await page.locator('#taskOptionValue').inputValue(), '@Keep me');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.defaults === null);
  assert.equal(new URL(page.url()).hash, '#capture');
  assert.equal((await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'))).queue.length, 0);
});

test('Task options do not overwrite defaults before built-in options are available', async t => {
  const { page } = await setup(t);
  await page.evaluate(async () => {
    const { transact } = await import('/inbox-store.js?v=15');
    await transact('alice', local => { delete local.defaultSettings; });
    const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close();
  });
  await openPreferences(page);
  await page.locator('#preference-task-options').click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Reconnect once to load the built-in options'));
  assert.equal(new URL(page.url()).hash, '#preferences');
  assert.equal(await page.locator('#taskOptionsView').isVisible(), false);
  const local = await page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'));
  assert.equal(local.queue.length, 0);
  assert.equal(local.preferenceDraft?.defaults, undefined);
});
