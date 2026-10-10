import { clickControl } from './navigation-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { validateSuggestion } from '../../html/local-guidance.js';

test('local guidance accepts only bounded text suggestions, never record fields', () => {
  assert.equal(validateSuggestion('{"text":"Call the insurer"}', 200), 'Call the insurer');
  for (const raw of ['not json', 'null', '[]', '{"text":2}', '{"text":" "}', '{"text":"Okay","status":"done"}', JSON.stringify({ text: 'a'.repeat(201) }), 'a'.repeat(24001)]) assert.throws(() => validateSuggestion(raw, 200));
});

const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=9')).transact('alice'));
async function setup(t, mode = {}) {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(mode => {
    window.aiCalls = { availability: [], create: [], prompt: [], destroyed: 0 };
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: mode.absent ? undefined : {
      availability: async options => { aiCalls.availability.push(options); if (mode.checkFail) throw Error('Check failed'); return mode.state || 'available'; },
      create: options => {
        aiCalls.create.push({ expectedInputs: options.expectedInputs, expectedOutputs: options.expectedOutputs, active: navigator.userActivation.isActive });
        options.monitor(new EventTarget());
        return Promise.resolve({ destroy() { aiCalls.destroyed++; }, prompt: async (text, opts) => {
          aiCalls.prompt.push({ text, schema: opts.responseConstraint });
          if (mode.promptFail) throw Error('Inference failed');
          return mode.raw || '{"text":"Coverage in place"}';
        } });
      }
    } });
  }, mode);
  const page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.locator('#captureText').fill('sort out insurance'); await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await page.locator('a[href="#work"]').click(); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  await page.getByRole('button', { name: 'Action', exact: true }).click();
  await page.locator('#localGuidance summary').click();
  await page.waitForFunction(() => !document.querySelector('#guidanceStatus').textContent.startsWith('Checking'));
  return { page, context };
}

for (const mode of [{ absent: true }, { state: 'unavailable' }, { checkFail: true }]) test('manual v3 clarification survives unsupported local AI ' + JSON.stringify(mode), async t => {
  const { page } = await setup(t, mode);
  assert.equal(await page.locator('#guidanceStart').isDisabled(), true);
  await page.locator('[data-proposal=title]').fill('My own next action');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyQuestion').textContent === 'Session summary');
  assert.equal(await page.evaluate(() => aiCalls.create.length), 0);
});

test('local suggestion stays separate until chosen and journals the v3 action draft offline', { timeout: 60000 }, async t => {
  const { page, context } = await setup(t);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.locator('[data-proposal=title]').fill('My existing draft');
  await page.locator('#guidanceStart').click(); await page.locator('#guidanceUse').waitFor();
  assert.equal(await page.locator('[data-proposal=title]').inputValue(), 'My existing draft');
  assert.equal((await local(page)).queue.length, 0);
  await page.locator('#guidanceUse').click();
  assert.equal(await page.locator('[data-proposal=title]').inputValue(), 'Coverage in place');
  await page.waitForTimeout(500);
  assert.equal((await local(page)).draft.clarification?.proposal.title, 'Coverage in place');
  await page.reload(); await page.locator('#clarifier').waitFor();
  assert.equal(await page.locator('[data-proposal=title]').inputValue(), 'Coverage in place');
  assert.equal(await page.locator('#guidancePreview').isVisible(), false);
});

test('failed local guidance preserves the v3 draft and treats model markup as text', async t => {
  const { page } = await setup(t, { raw: JSON.stringify({ text: '<img src=x onerror="window.injected=1">' }) });
  await page.locator('[data-proposal=title]').fill('Keep this');
  await page.locator('#guidanceStart').click(); await page.locator('#guidanceUse').waitFor();
  assert.equal(await page.locator('#guidancePreview img').count(), 0);
  assert.equal(await page.locator('[data-proposal=title]').inputValue(), 'Keep this');
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal((await local(page)).queue.length, 0);
});
