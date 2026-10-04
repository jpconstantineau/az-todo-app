import { clickControl } from './navigation-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { validateSuggestion } from '../../html/local-guidance.js';

test('local guidance accepts only bounded text suggestions, never record fields', () => {
  assert.equal(validateSuggestion('{"text":"Call the insurer"}', 200), 'Call the insurer');
  for (const raw of ['not json', 'null', '[]', '{"text":2}', '{"text":" "}', '{"text":"Okay","status":"done"}', JSON.stringify({ text: 'a'.repeat(201) }), 'a'.repeat(24001)]) assert.throws(() => validateSuggestion(raw, 200));
});

const local = page => page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
async function setup(t, mode = {}) {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(mode => {
    window.aiCalls = { availability: [], create: [], prompt: [], destroyed: 0 };
    window.aiMode = mode;
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: mode.absent ? undefined : {
      availability: async options => { aiCalls.availability.push(options); if (aiMode.checkFail) throw Error('Check failed'); return aiMode.state || 'available'; },
      create: options => {
        aiCalls.create.push({ expectedInputs: options.expectedInputs, expectedOutputs: options.expectedOutputs, active: navigator.userActivation.isActive });
        const monitor = new EventTarget(); options.monitor(monitor);
        window.progress = loaded => { const event = new Event('downloadprogress'); event.loaded = loaded; monitor.dispatchEvent(event); };
        const model = { destroy() { aiCalls.destroyed++; }, prompt: async (text, opts) => {
          aiCalls.prompt.push({ text, schema: opts.responseConstraint });
          if (aiMode.promptFail) throw Error('Inference failed');
          if (aiMode.delayPrompt) return new Promise(resolve => { window.finishPrompt = resolve; });
          return aiMode.raw || '{"text":"Coverage in place"}';
        } };
        if (aiMode.createFail) return Promise.reject(Error('Initialization failed'));
        if (aiMode.delayCreate) return new Promise(resolve => { window.finishCreate = () => resolve(model); });
        return Promise.resolve(model);
      }
    } });
  }, mode);
  const page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.locator('#captureText').fill('sort out insurance');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  // Preserve coverage for guidance in an existing, pre-upgrade questionnaire.
  await page.evaluate(async () => {
    const { transact, enqueue } = await import('/inbox-store.js');
    await transact('alice', local => {
      const item = Object.values(local.records).find(record => record.type === 'item');
      enqueue(local, 'alice', [{ type: 'clarification', id: item.id, action: 'create', expectedVersion: 0,
        fields: { step: 0, answers: {}, proposal: { text: '', status: '', waitingOn: '', reviewDate: '', startDate: '' } } }]);
    });
  });
  await clickControl(page.locator('#sync'));
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await page.locator('a[href="#work"]').click();
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  await page.locator('#localGuidance').waitFor();
  await page.locator('#localGuidance summary').click();
  await page.waitForFunction(() => !document.querySelector('#guidanceStatus').textContent.startsWith('Checking'));
  return { page, context, browser, setUser: value => { user = value; } };
}

for (const mode of [{ absent: true }, { state: 'unavailable' }, { checkFail: true }]) test('manual clarification survives unsupported local AI ' + JSON.stringify(mode), async t => {
  const { page } = await setup(t, mode);
  assert.equal(await page.locator('#guidanceStart').isDisabled(), true);
  await page.locator('#clarifyForm [name=text]').fill('My own outcome');
  await page.locator('#clarifyAccept').click();
  await page.waitForFunction(() => document.querySelector('#clarifyHeading').textContent === 'Question 2 of 4');
  assert.equal(await page.evaluate(() => aiCalls.create.length), 0);
});

test('local suggestion stays separate until chosen, journals offline, reloads and accepts through normal flow', { timeout: 60000 }, async t => {
  const { page, context, browser } = await setup(t);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.locator('#clarifyForm [name=text]').fill('My existing draft');
  await page.locator('#guidanceStart').click(); await page.locator('#guidanceUse').waitFor();
  assert.equal(await page.locator('#agentStatus').getAttribute('data-state'), 'available');
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'My existing draft');
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.evaluate(() => aiCalls.create[0].active), true);
  const calls = await page.evaluate(() => aiCalls);
  assert.deepEqual(calls.availability[0], { expectedInputs: calls.create[0].expectedInputs, expectedOutputs: calls.create[0].expectedOutputs });
  assert.equal(calls.destroyed, 1);
  if (process.env.GUIDANCE_SCREENSHOTS) {
    await mkdir(process.env.GUIDANCE_SCREENSHOTS, { recursive: true });
    console.log('Local guidance mocked browser:', browser.version());
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: process.env.GUIDANCE_SCREENSHOTS + '/guidance-' + theme + '-' + width + '.png' });
    }
  }
  await page.locator('#guidanceUse').click();
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Coverage in place');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.clarification.proposal.text === 'Coverage in place');
  assert.equal((await local(page)).queue.length, 0);
  await page.reload(); await page.locator('#clarifier').waitFor();
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Coverage in place');
  assert.equal(await page.locator('#guidancePreview').isVisible(), false);
  await page.locator('#clarifyAccept').click();
  await page.waitForFunction(() => document.querySelector('#clarifyHeading').textContent === 'Question 2 of 4');
  const state = await local(page);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].operation.mutations[0].fields.answers.outcome.value, 'Coverage in place');
});

for (const mode of [{ createFail: true }, { promptFail: true }, { raw: '{"text":"Injected","status":"done"}' }]) test('failed local AI preserves draft ' + JSON.stringify(mode), async t => {
  const { page } = await setup(t, mode);
  await page.locator('#clarifyForm [name=text]').fill('Keep this');
  await page.locator('#guidanceStart').click();
  await page.waitForFunction(() => document.querySelector('#guidanceStatus').textContent.includes('could not produce'));
  assert.equal(await page.locator('#agentStatus').getAttribute('data-state'), 'error');
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Keep this');
  assert.equal(await page.locator('#guidanceUse').isVisible(), false);
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.evaluate(() => aiCalls.destroyed), mode.createFail ? 0 : 1);
});

for (const state of ['downloadable', 'downloading']) test('download progress and cancellation discard late initialization: ' + state, async t => {
  const { page } = await setup(t, { state, delayCreate: true });
  assert.equal(await page.evaluate(() => aiCalls.create.length), 0);
  await page.locator('#clarifyForm [name=text]').fill('Keep me');
  await page.locator('#guidanceStart').click();
  assert.equal(await page.locator('#agentStatus').getAttribute('data-state'), 'busy');
  await page.evaluate(() => progress(0.5));
  assert.match(await page.locator('#guidanceStatus').textContent(), /50%/);
  await page.locator('#guidanceCancel').click();
  assert.equal(await page.locator('#agentStatus').getAttribute('aria-disabled'), 'false');
  await page.evaluate(() => finishCreate());
  await page.waitForFunction(() => aiCalls.destroyed === 1);
  assert.equal(await page.evaluate(() => aiCalls.prompt.length), 0);
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Keep me');
  assert.equal((await local(page)).queue.length, 0);
});

test('editing, skipping, closing and account changes invalidate late inference', async t => {
  const { page, setUser } = await setup(t, { delayPrompt: true });
  for (const action of ['edit', 'skip', 'close', 'account']) {
    await page.locator('#guidanceStart').click(); await page.waitForFunction(() => !!window.finishPrompt);
    if (action === 'edit') await page.locator('#clarifyForm [name=text]').fill('Newer draft');
    if (action === 'skip') { await page.locator('#clarifySkip').click(); await page.waitForFunction(() => document.querySelector('#clarifyHeading').textContent === 'Question 2 of 4'); }
    if (action === 'close') await page.locator('#clarifyStop').click();
    if (action === 'account') { setUser('bob'); await page.evaluate(() => document.querySelector('#sync').click()); await page.waitForFunction(() => !document.querySelector('#items').textContent.includes('insurance')); }
    await page.evaluate(() => { finishPrompt('{"text":"Stale answer"}'); window.finishPrompt = null; });
    assert.equal(await page.locator('#guidancePreview').textContent(), '');
    assert.equal(await page.locator('#guidanceUse').isVisible(), false);
    if (action === 'edit') assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Newer draft');
    if (action === 'close') await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  }
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), '');
});

test('model markup renders as text and cannot execute', async t => {
  const { page } = await setup(t, { raw: JSON.stringify({ text: '<img src=x onerror="window.injected=1">' }) });
  await page.locator('#guidanceStart').click(); await page.locator('#guidanceUse').waitFor();
  assert.equal(await page.locator('#guidancePreview img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal((await local(page)).queue.length, 0);
});
