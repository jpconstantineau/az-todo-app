import { clickControl } from './navigation-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

async function setup(t) {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url);
  await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await context.setOffline(true);
  return { page, context };
}
async function capture(page, text) {
  await page.locator('#captureText').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
}
const expectFocus = (page, selector) => page.waitForFunction(selector => document.activeElement.matches(selector), selector);
async function keyboardActivate(page, selector) {
  for (let i = 0; i < 80; i++) {
    if (await page.locator(selector).evaluate(control => control === document.activeElement)) {
      await page.keyboard.press('Enter'); return;
    }
    await page.keyboard.press('Tab');
  }
  assert.fail(`Keyboard could not reach ${selector}`);
}
async function refresh(page) {
  // Same-account background refresh, without clicking a different control.
  await page.evaluate(() => {
    const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close();
  });
}

async function delayDeviceSave(page) {
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
      const delay = this.mode === 'readwrite' && window.delayCaptureSave;
      if (delay) window.delayCaptureSave = false;
      descriptor.set.call(this, delay ? function (event) { window.releaseCaptureSave = () => callback.call(this, event); } : callback);
    } });
    window.delayCaptureSave = true;
  });
}

test('accessibility: capture save preserves a later control choice and still supports quick-add', { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  await page.locator('#captureText').fill('First task');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).draft.capture.text === 'First task');
  await delayDeviceSave(page);
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => !!window.releaseCaptureSave);
  await keyboardActivate(page, '#captureOptions > summary');
  await page.locator('#capture [name=body]').focus();
  await page.keyboard.type('Notes for my next capture');
  await page.evaluate(() => releaseCaptureSave());
  await page.waitForFunction(() => !document.querySelector('#capture [type=submit]').disabled);
  await expectFocus(page, '#capture [name=body]');
  assert.equal(await page.locator('#capture [name=body]').inputValue(), 'Notes for my next capture');
  await page.locator('#captureText').fill('Next task');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await expectFocus(page, '#captureText');
});

test('accessibility: review decisions and brief revisions keep a keyboard path to their results', { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  await capture(page, 'Insurance\nPolicy');
  await keyboardActivate(page, '#openReviews');
  await keyboardActivate(page, '#startDaily');
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 0'));
  await expectFocus(page, '#reviewTitle');
  await keyboardActivate(page, '#startWeekly');
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 2'));
  await expectFocus(page, '#reviewTitle');
  await keyboardActivate(page, '#reviewDeferSave');
  await page.waitForFunction(() => document.querySelector('#reviewError').textContent.includes('Choose a calendar date'));
  await expectFocus(page, '#reviewDeferSave');
  await keyboardActivate(page, '#reviewRetain');
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 2'));
  await expectFocus(page, '#reviewTitle');
  assert.equal(await page.locator('#reviewTitle').textContent(), 'Policy');
  await keyboardActivate(page, '#reviewDrop');
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('2 of 2'));
  await expectFocus(page, '#reviewTitle');
  await keyboardActivate(page, '#reviewUndo');
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 2'));
  await expectFocus(page, '#reviewTitle');
  await keyboardActivate(page, '#closeReviews'); await expectFocus(page, '#openReviews');
  await keyboardActivate(page, 'a[href="#work"]');
  await expectFocus(page, '#itemsHeading');
  await keyboardActivate(page, '[aria-label="Brief Insurance"]');
  await expectFocus(page, '#briefHeading');
  await keyboardActivate(page, '#briefForm [type=submit]');
  await page.waitForFunction(() => !!document.querySelector('#briefRevisions').value);
  await expectFocus(page, '#briefState');
  await keyboardActivate(page, '#briefForm [type=submit]');
  await page.waitForFunction(() => document.querySelector('#briefError').textContent.includes('Edit the content'));
  await expectFocus(page, '#briefForm [type=submit]');
  await keyboardActivate(page, '#briefAccept');
  await page.waitForFunction(() => document.querySelector('#briefState').textContent.startsWith('accepted'));
  await expectFocus(page, '#briefState');
  const download = page.waitForEvent('download');
  await keyboardActivate(page, '#briefExport');
  assert.match((await download).suggestedFilename(), /unconfirmed\.txt$/);
  await expectFocus(page, '#briefExport');
  await page.keyboard.press('Escape');
  await expectFocus(page, '[aria-label="Brief Insurance"]');
});

test('accessibility: delayed review and brief saves preserve a later focus choice', { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  await capture(page, 'Insurance');
  await page.evaluate(() => {
    // Delay delivery of one committed IndexedDB transaction, without mocking
    // the application save or changing when the actual data becomes durable.
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
      const delay = this.mode === 'readwrite' && window.delaySave;
      if (delay) window.delaySave = false;
      descriptor.set.call(this, delay ? function (event) { window.releaseSave = () => callback.call(this, event); } : callback);
    } });
  });
  await keyboardActivate(page, '#openReviews');
  await page.evaluate(() => { window.delaySave = true; });
  await keyboardActivate(page, '#startWeekly');
  await page.waitForFunction(() => !!window.releaseSave);
  await keyboardActivate(page, '#closeReviews');
  await expectFocus(page, '#openReviews');
  await page.evaluate(() => { releaseSave(); window.releaseSave = null; });
  await page.waitForFunction(() => !document.querySelector('#startWeekly').disabled);
  await expectFocus(page, '#openReviews');
  await keyboardActivate(page, 'a[href="#work"]');
  await keyboardActivate(page, '[aria-label="Brief Insurance"]');
  await page.evaluate(() => { window.delaySave = true; });
  await keyboardActivate(page, '#briefForm [type=submit]');
  await page.waitForFunction(() => !!window.releaseSave);
  await page.keyboard.press('Tab');
  await expectFocus(page, '#briefs a');
  await page.evaluate(() => { releaseSave(); window.releaseSave = null; });
  await page.waitForFunction(() => !document.querySelector('#briefForm [type=submit]').disabled);
  await expectFocus(page, '#briefs a');
});

test('accessibility: brief storage errors return focus and unchanged review/brief status stays quiet', { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  await capture(page, 'Insurance');
  await keyboardActivate(page, '#openReviews');
  await keyboardActivate(page, '#startWeekly');
  await expectFocus(page, '#reviewTitle');
  await page.keyboard.press('Escape');
  await keyboardActivate(page, 'a[href="#work"]');
  await keyboardActivate(page, '[aria-label="Brief Insurance"]');
  await page.locator('#briefForm [name=outcome]').fill('Coverage');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).draft.brief?.content.outcome === 'Coverage');
  await page.evaluate(() => {
    window.announcements = [];
    for (const id of ['briefState', 'reviewProgress']) new MutationObserver(() => announcements.push(id)).observe(document.getElementById(id), { childList: true, subtree: true, characterData: true });
  });
  await page.locator('#briefForm [name=outcome]').fill('Coverage in place');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).draft.brief?.content.outcome === 'Coverage in place');
  await page.evaluate(() => { window.oldRow = document.querySelector('#items article'); });
  await refresh(page);
  await page.waitForFunction(() => !window.oldRow.isConnected);
  assert.deepEqual(await page.evaluate(() => announcements), []);
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await keyboardActivate(page, '#briefForm [type=submit]');
  await page.waitForFunction(() => document.querySelector('#briefError').textContent.includes('Quota exceeded'));
  await expectFocus(page, '[aria-label="Brief Insurance"]');
  assert.equal(await page.locator('#briefs').isVisible(), false);
  assert.match(await page.locator('#recoveryText').inputValue(), /Coverage in place/);
  assert.equal(await page.locator('#briefForm [name=outcome]').inputValue(), 'Coverage in place');
});

test('accessibility: keyboard actions and editor return focus survive background row replacement and renaming', { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  await capture(page, 'Same title\nSame title');
  await showView(page, 'work');
  await showView(page, 'work'); await page.locator('#view').selectOption('all'); await page.locator('#statusFilter').selectOption('@all');
  const id = await page.locator('#items article').nth(1).getAttribute('data-id');
  const row = `article[data-id="${id}"]`;
  await page.locator(`${row} button`).first().focus();
  await page.evaluate(() => { window.oldFocus = document.activeElement; });
  await refresh(page);
  await page.waitForFunction(() => !window.oldFocus.isConnected);
  await expectFocus(page, `${row} button:first-child`);
  await page.keyboard.press('Enter');
  await expectFocus(page, '#edit [name=title]');
  await page.keyboard.press('Control+A'); await page.keyboard.type('Renamed task');
  await refresh(page);
  await expectFocus(page, '#edit [name=title]');
  await page.locator('#edit [type=submit]').focus(); await page.keyboard.press('Enter');
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await expectFocus(page, `${row} button:first-child`);
  assert.equal(await page.locator(`${row} button`).first().getAttribute('aria-label'), 'Edit Renamed task');
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Reopen Renamed task', exact: true }).waitFor();
  await expectFocus(page, `${row} [data-focus-key$=":complete"]`);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Complete Renamed task', exact: true }).waitFor();
  await expectFocus(page, `${row} [data-focus-key$=":complete"]`);
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter');
  await page.locator('#editor').waitFor(); await refresh(page);
  await page.keyboard.press('Escape');
  await expectFocus(page, `${row} button:first-child`);
  // If a completed row leaves the current filter, use the visible view heading.
  await page.locator('#statusFilter').selectOption('inbox');
  await page.locator(`${row} [data-focus-key$=":complete"]`).focus(); await page.keyboard.press('Enter');
  await page.locator(row).waitFor({ state: 'detached' });
  await expectFocus(page, '#itemsHeading');
});

test('accessibility: typing and unchanged refreshes do not repeat live-region announcements', { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  await page.locator('#captureText').fill('First draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).draft.capture?.text === 'First draft');
  assert.equal(await page.locator('#draftStatus').textContent(), '');
  await page.evaluate(() => {
    window.announcements = [];
    for (const id of ['draftStatus', 'syncStatus']) {
      new MutationObserver(() => window.announcements.push(id)).observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
    }
  });
  await page.locator('#captureText').fill('Second draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).draft.capture?.text === 'Second draft');
  await clickControl(page.locator('#sync'));
  assert.deepEqual(await page.evaluate(() => window.announcements), []);
  await page.locator('#captureText').focus(); await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  assert.ok((await page.evaluate(() => window.announcements)).includes('draftStatus'));
  assert.ok((await page.evaluate(() => window.announcements)).includes('syncStatus'));
});

test('accessibility: list, project, defaults and clarification dialogs return to their original controls', { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  await capture(page, 'Insurance');
  await showView(page, 'work');
  await keyboardActivate(page, '[aria-label="Clarify Insurance"]');
  await expectFocus(page, '#clarifyQuestion');
  await page.keyboard.press('Tab');
  await expectFocus(page, '[data-proposal=title]');
  await page.keyboard.press('Tab'); await expectFocus(page, '#clarifyFlow .clarify-grid > button:first-child');
  await page.keyboard.press('Escape');
  await expectFocus(page, '[aria-label="Clarify Insurance"]');
  await page.locator('#newProject').focus(); await page.keyboard.press('Enter');
  await page.locator('#edit [name=title]').fill('Coverage');
  await page.locator('#edit [name=outcome]').fill('An insured home');
  await page.locator('#edit [type=submit]').focus(); await page.keyboard.press('Enter');
  await expectFocus(page, '#newProject');
  const projectValue = await page.locator('#view option').filter({ hasText: 'Project: Coverage' }).getAttribute('value');
  await page.locator('#view').selectOption(projectValue);
  await page.getByRole('button', { name: 'Edit project: Coverage', exact: true }).focus(); await page.keyboard.press('Enter');
  await refresh(page); await page.keyboard.press('Escape');
  await expectFocus(page, '[aria-label="Edit project: Coverage"]');

  await showView(page, 'lists');
  await page.locator('#newList').focus(); await page.keyboard.press('Enter');
  await page.locator('#edit [name=title]').fill('Home');
  await page.locator('#edit [type=submit]').focus(); await page.keyboard.press('Enter');
  await expectFocus(page, '#newList');
  await page.locator('#view').selectOption({ label: 'Home' });
  await page.getByRole('button', { name: 'Edit list: Home', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.locator('#edit [name=title]').fill('Household');
  await page.locator('#edit [type=submit]').focus(); await page.keyboard.press('Enter');
  await expectFocus(page, '[aria-label="Edit list: Household"]');
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expectFocus(page, '#defaultsForm [name=contexts]');
  await page.locator('#defaultsForm [name=contexts]').fill('At home');
  await page.locator('#defaultsForm [type=submit]').focus(); await page.keyboard.press('Enter');
  await expectFocus(page, '[aria-label="Defaults: Household"]');
  await page.locator('#appMenu > summary').focus(); await page.keyboard.press('Enter');
  await page.locator('#userDefaults').focus(); await page.keyboard.press('Enter');
  await expectFocus(page, '#defaultsEditor:modal #defaultsForm [name=contexts]');
  await page.keyboard.press('Escape'); await expectFocus(page, '#userDefaults');
  await page.getByRole('button', { name: 'Preferences', exact: true }).focus(); await page.keyboard.press('Enter');
  await expectFocus(page, '#preferences:modal [data-appearance]');
  await page.keyboard.press('Escape'); await expectFocus(page, '[data-open-preferences]');
  await page.locator('#openReviews').focus(); await page.keyboard.press('Enter');
  await expectFocus(page, '#reviewsHeading');
  assert.equal(await page.locator('dialog:modal').count(), 0);
  await keyboardActivate(page, '#closeReviews'); await expectFocus(page, '#openReviews');
  // Force native closes into one task so the earlier close events arrive
  // after focus has moved on. It must not steal the later dialog's return focus.
  await page.evaluate(async () => {
    const defaults = document.querySelector('#defaultsEditor'), preferences = document.querySelector('#preferences');
    const closed = [defaults, preferences].map(dialog => new Promise(resolve => dialog.addEventListener('close', resolve, { once: true })));
    const defaultsButton = document.querySelector('#userDefaults'), preferencesButton = document.querySelector('[data-open-preferences]');
    defaultsButton.focus(); defaultsButton.click(); defaults.close();
    preferencesButton.focus(); preferencesButton.click(); preferences.close();
    await Promise.all(closed);
  });
  await expectFocus(page, '[data-open-preferences]');
  await page.locator('#exportTools > summary').focus(); await page.keyboard.press('Enter');
  await page.locator('#export').focus();
  const download = page.waitForEvent('download'); await page.keyboard.press('Enter');
  assert.equal((await download).suggestedFilename(), 'todo-device-recovery.json');
  await expectFocus(page, '#export');
});

test('accessibility: repeated verified sync leaves an unchanged account announcement alone', { timeout: 60000 }, async t => {
  const { page, context } = await setup(t);
  await page.route('**/.auth/me', route => route.fulfill({ json: { clientPrincipal: { userId: 'alice', userDetails: 'alice-handle' } } }));
  await context.setOffline(false);
  await clickControl(page.locator('#sync'));
  await page.waitForFunction(() => document.querySelector('#sessionStatus').textContent === 'Device inbox for alice-handle');
  await page.evaluate(() => {
    window.accountAnnouncements = 0;
    new MutationObserver(() => window.accountAnnouncements++).observe(document.querySelector('#sessionStatus'), { childList: true });
  });
  const response = page.waitForResponse('**/.auth/me');
  await clickControl(page.locator('#sync')); await response;
  // Wait for the ensuing change request and render, after profile completion.
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  assert.equal(await page.evaluate(() => window.accountAnnouncements), 0);
});
