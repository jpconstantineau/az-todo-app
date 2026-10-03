import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';

const source = 'Call Sam tomorrow at 3 pm about insurance. Buy milk.';
const item = { title: 'Call Sam', description: 'Discuss insurance.', dateText: 'tomorrow', timeText: '3 pm', listId: '', priority: '', contexts: [], areas: [], uncertainty: '' };
const raw = JSON.stringify({ items: [item, { ...item, title: 'Buy milk', description: '', dateText: '', timeText: '' }] });
const local = page => page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
async function setup(t, mode = {}) {
  documents.length = 0; let user = 'alice';
  Object.assign(faults, { nextWrite: false, batchIndex: -1, loseBatchResponse: false });
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Regina' });
  await context.addInitScript(({ mode, raw }) => {
    window.aiCalls = { create: [], prompts: [], destroyed: 0 };
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: mode.absent ? undefined : {
      availability: async options => { aiCalls.options = options; return mode.state || 'available'; },
      create: options => {
        aiCalls.create.push({ active: navigator.userActivation.isActive, expectedInputs: options.expectedInputs, expectedOutputs: options.expectedOutputs });
        const monitor = new EventTarget(); options.monitor(monitor);
        window.progress = loaded => { const event = new Event('downloadprogress'); event.loaded = loaded; monitor.dispatchEvent(event); };
        const model = { destroy() { aiCalls.destroyed++; }, prompt: async text => {
          aiCalls.prompts.push(text);
          aiCalls.durableSource = (await (await import('/inbox-store.js')).transact('alice')).draft.extraction?.text;
          if (mode.promptFail) throw Error('Failed');
          if (mode.delayPrompt) return new Promise(resolve => { window.finishPrompt = resolve; });
          return mode.raw ?? raw;
        } };
        if (mode.createFail) return Promise.reject(Error('Failed'));
        if (mode.delayCreate) return new Promise(resolve => { window.finishCreate = () => resolve(model); });
        return Promise.resolve(model);
      }
    } });
  }, { mode, raw });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#captureText').waitFor();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await page.locator('#captureText').fill(source);
  await page.locator('#localCapture summary').first().click();
  await page.waitForFunction(() => !!document.querySelector('#captureAIStatus').textContent);
  if (!mode.absent && mode.state !== 'unavailable') await page.waitForFunction(() => !document.querySelector('#captureSuggest').disabled);
  return { page, context, browser, setUser: value => { user = value; } };
}
async function suggest(page) {
  await page.locator('#captureSuggest').click();
  await page.locator('#captureReview').waitFor();
  await page.waitForFunction(() => !document.querySelector('#captureReturn').disabled && document.querySelector('#captureSuggestCancel').hidden);
}

test('local capture persists the original before inference, edits offline, reloads and accepts exactly one batch', { timeout: 60000 }, async t => {
  const { page, context, browser } = await setup(t);
  await context.setOffline(true);
  await suggest(page);
  const calls = await page.evaluate(() => aiCalls);
  assert.equal(calls.durableSource, source); assert.equal(calls.create[0].active, true);
  assert.deepEqual(calls.options, { expectedInputs: calls.create[0].expectedInputs, expectedOutputs: calls.create[0].expectedOutputs });
  assert.equal(calls.destroyed, 1); assert.equal((await local(page)).queue.length, 0);
  const first = page.locator('#captureReviewItems fieldset').first();
  await first.locator('[data-field=title]').fill('Call Sam with policy number');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.extraction.items[0].title === 'Call Sam with policy number');
  const saved = (await local(page)).draft.extraction;
  await page.reload(); await page.locator('#captureReview').waitFor();
  assert.equal(await page.locator('#captureReviewItems [data-field=title]').first().inputValue(), saved.items[0].title);
  assert.equal(await page.evaluate(() => aiCalls.create.length), 0);
  assert.deepEqual((await local(page)).draft.extraction, saved);
  if (process.env.CAPTURE_SCREENSHOTS) {
    await mkdir(process.env.CAPTURE_SCREENSHOTS, { recursive: true });
    console.log('Local capture mocked browser:', browser.version());
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: process.env.CAPTURE_SCREENSHOTS + '/capture-' + width + '.png', fullPage: true });
    }
  }
  await page.locator('#captureAccept').dblclick({ force: true });
  await page.waitForFunction(() => document.querySelector('#captureReview').hidden);
  let state = await local(page); assert.equal(state.queue.length, 1); assert.equal(state.queue[0].operation.mutations.length, 2);
  const mutations = state.queue[0].operation.mutations;
  assert.equal(mutations[0].id, saved.items[0].id); assert.equal(mutations[0].fields.originalText, source);
  assert.equal(mutations[0].fields.capture.id, saved.id); assert.equal(state.draft.extraction, null);
  await page.reload(); await page.locator('#captureText').waitFor();
  assert.equal(await page.locator('#captureText').inputValue(), '');
  assert.equal(await page.locator('#captureReview').isVisible(), false);
  faults.loseBatchResponse = true;
  await context.setOffline(false);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).queue.length === 0);
  state = await local(page);
  assert.equal(Object.values(state.records).filter(record => record.type === 'item').length, 2);
  assert.equal(documents.filter(doc => doc.kind === 'record' && doc.record.type === 'item').length, 2);
});

for (const mode of [{ absent: true }, { state: 'unavailable' }]) test('manual review supports free-form captures without local AI ' + JSON.stringify(mode), async t => {
  const { page } = await setup(t, mode);
  assert.equal(await page.locator('#captureSuggest').isDisabled(), true);
  await page.locator('#captureManualReview').click();
  await page.locator('#captureReviewItems [data-field=title]').fill('Insurance and groceries');
  await page.locator('#captureAccept').click();
  await page.waitForFunction(() => document.querySelector('#captureReview').hidden);
  await waitForBrowser(page, async () => Object.values((await (await import('/inbox-store.js')).transact('alice')).records).some(record => record.title === 'Insurance and groceries'));
  assert.equal(await page.evaluate(() => aiCalls.create.length), 0);
});

for (const mode of [{ createFail: true }, { promptFail: true }, { raw: '{"items":[{"title":"Injected","accountId":"bob"}]}' }]) test('local AI failure keeps source and manual save path ' + JSON.stringify(mode), async t => {
  const { page } = await setup(t, mode);
  await page.locator('#captureSuggest').click();
  await page.waitForFunction(() => document.querySelector('#captureAIStatus').textContent.includes('could not finish'));
  assert.equal(await page.locator('#captureText').inputValue(), source);
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.locator('#captureReview').isVisible(), false);
  assert.equal(await page.locator('#capture button[type=submit]').isDisabled(), false);
});

test('download cancellation, stale source and account changes discard late results', async t => {
  const { page, setUser } = await setup(t, { delayPrompt: true });
  for (const action of ['edit', 'cancel', 'account']) {
    await page.locator('#captureSuggest').click(); await page.waitForFunction(() => !!window.finishPrompt);
    if (action === 'edit') await page.locator('#captureText').fill('Newer source');
    if (action === 'cancel') await page.locator('#captureSuggestCancel').click();
    if (action === 'account') { setUser('bob'); await page.evaluate(() => document.querySelector('#sync').click()); await page.waitForFunction(() => document.querySelector('#captureText').value === ''); }
    await page.evaluate(raw => { finishPrompt(raw); window.finishPrompt = null; }, raw);
    assert.equal(await page.locator('#captureReview').isVisible(), false);
    assert.equal((await local(page)).queue.length, 0);
    assert.equal(await page.locator('#captureAILists').isDisabled(), false);
  }
  assert.equal(await page.locator('#captureOriginal').textContent(), '');
});

test('late model creation is released after cancellation without sending the capture', async t => {
  const { page } = await setup(t, { state: 'downloadable', delayCreate: true });
  await page.locator('#captureSuggest').click(); await page.evaluate(() => progress(0.5));
  assert.match(await page.locator('#captureAIStatus').textContent(), /50%/);
  await page.locator('#captureSuggestCancel').click(); await page.evaluate(() => finishCreate());
  await page.waitForFunction(() => aiCalls.destroyed === 1);
  assert.equal(await page.evaluate(() => aiCalls.prompts.length), 0);
});

test('review supports remove, merge, manual split, text-only markup and explicit discard before reprocessing', async t => {
  const injection = '<img src=x onerror="window.injected=1">';
  const { page } = await setup(t, { raw: JSON.stringify({ items: [{ ...item, title: injection }, { ...item, title: 'Buy milk' }] }) });
  await suggest(page);
  assert.equal(await page.locator('#captureReview img').count(), 0);
  await page.getByRole('button', { name: 'Merge into previous task' }).click();
  assert.equal(await page.locator('#captureReviewItems fieldset').count(), 1);
  assert.match(await page.locator('[data-field=description]').inputValue(), /Buy milk/);
  await page.locator('#captureAdd').click();
  await page.locator('#captureReviewItems fieldset').last().locator('[data-field=title]').fill('Split task');
  await page.locator('#captureReviewItems fieldset').first().getByRole('button', { name: 'Remove suggestion' }).click();
  assert.equal(await page.locator('[data-field=title]').inputValue(), 'Split task');
  assert.equal(await page.locator('#captureSuggest').isDisabled(), true);
  await page.locator('#captureReturn').click();
  assert.equal(await page.locator('#captureText').inputValue(), source);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal((await local(page)).queue.length, 0);
});

test('storage failure prevents inference and keeps edited review recoverable on failed acceptance', async t => {
  const { page, context } = await setup(t);
  await context.setOffline(true);
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); };
  });
  await page.locator('#captureSuggest').click();
  await page.locator('#recovery').waitFor();
  await page.waitForFunction(() => document.querySelector('#captureAIStatus').textContent.includes('could not finish'));
  assert.equal(await page.evaluate(() => aiCalls.prompts.length), 0);
  assert.match(await page.locator('#recoveryText').inputValue(), /Call Sam/);
  await page.evaluate(() => { IDBObjectStore.prototype.put = originalPut; });
  await suggest(page);
  await page.locator('[data-field=title]').first().fill('Keep this reviewed edit');
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await page.locator('#captureAccept').click();
  await page.waitForFunction(() => document.querySelector('#captureAIStatus').textContent.includes('Your review is kept'));
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.locator('[data-field=title]').first().inputValue(), 'Keep this reviewed edit');
  await page.evaluate(() => { IDBObjectStore.prototype.put = originalPut; });
  await page.locator('#captureAccept').click();
  await page.waitForFunction(() => document.querySelector('#captureReview').hidden);
  assert.equal((await local(page)).queue.length, 1);
});

test('two tabs accepting the same restored preview cannot duplicate its stable item IDs', async t => {
  const { page, context } = await setup(t);
  await context.setOffline(true); await suggest(page);
  const second = await context.newPage(); await second.goto(page.url()); await second.locator('#captureReview').waitFor();
  await page.locator('#captureAccept').click(); await page.waitForFunction(() => document.querySelector('#captureReview').hidden);
  await second.locator('#captureAccept').click();
  await second.waitForFunction(() => document.querySelector('#captureAIStatus').textContent.includes('already saved'));
  assert.equal((await local(page)).queue.length, 1);
  assert.equal((await local(page)).queue[0].operation.mutations.length, 2);
});

test('no-action output retains its source, and list names enter the prompt only after explicit opt-in', async t => {
  const { page } = await setup(t, { raw: '{"items":[]}' });
  await page.evaluate(async () => {
    await (await import('/inbox-store.js')).transact('alice', local => {
      local.records['list:private'] = { type: 'list', id: 'private', title: 'Private list name', version: 1, accountId: 'alice', deleted: false };
    });
    document.querySelector('#sync').click();
  });
  await page.waitForFunction(() => [...document.querySelector('#capture [name=listId]').options].some(option => option.value === 'private'));
  await suggest(page);
  assert.equal(await page.locator('#captureAccept').isDisabled(), true);
  assert.ok(!(await page.evaluate(() => aiCalls.prompts[0])).includes('Private list name'));
  assert.equal((await local(page)).draft.extraction.text, source);
  await page.locator('#captureReturn').click();
  await page.locator('#captureAILists').check(); await suggest(page);
  assert.match(await page.evaluate(() => aiCalls.prompts[1]), /Private list name/);
  assert.equal((await local(page)).queue.length, 0);
});
