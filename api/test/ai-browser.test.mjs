import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl, showView } from './navigation-helper.mjs';

async function provider(t) {
  const calls = [], pending = [], state = { delay: false };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push(body);
    if (state.delay) await new Promise(resolve => pending.push(resolve));
    const clarification = body.response_format.json_schema.name === 'clarification';
    const content = clarification ? JSON.stringify({ text: 'Phone Sam' }) : JSON.stringify({ items: [{ title: 'Call Sam', description: '', listId: '', priority: '', context: '', dueDate: '', dueTime: '', evidence: 'Call Sam', uncertainty: '' }], notes: '' });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { calls, state, release() { pending.splice(0).forEach(resolve => resolve()); }, url: `http://127.0.0.1:${server.address().port}/chat/completions` };
}

async function browser(t, server, init) {
  const instance = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => instance.close());
  const context = await instance.newContext({ viewport: { width: 390, height: 844 } });
  if (init) await context.addInitScript(init);
  const page = await context.newPage(); await page.goto(server.url); await page.locator('#workspace').waitFor();
  return { page, context };
}

test('unsupported authenticated browsers explicitly review cloud capture and clarification suggestions', { timeout: 60000 }, async t => {
  documents.length = 0;
  const ai = await provider(t);
  const previous = [process.env.AI_API_URL, process.env.AI_API_KEY, process.env.AI_MODEL];
  Object.assign(process.env, { AI_API_URL: ai.url, AI_API_KEY: 'browser-secret', AI_MODEL: 'test/model' });
  t.after(() => ["AI_API_URL", "AI_API_KEY", "AI_MODEL"].forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]));
  let user = 'alice';
  const app = await startServer({ browserUser: () => user }); t.after(app.close);
  const { page } = await browser(t, app, () => Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: undefined }));
  await page.evaluate(async () => {
    await (await import('/inbox-store.js?v=9')).transact('alice', local => {
      local.records['list:private'] = { type: 'list', id: 'private', title: 'Private list name', workspaceId: 'personal', version: 1, accountId: 'alice', deleted: false };
    });
    document.querySelector('#sync').click();
  });
  await page.waitForFunction(() => [...document.querySelector('#capture [name=listId]').options].some(option => option.value === 'private'));
  await page.locator('#captureText').fill('Call Sam');
  await page.waitForFunction(() => document.querySelector('#extractStart').textContent === 'Suggest tasks with cloud AI');
  await page.locator('#captureAI summary').click();
  assert.equal(await page.locator('#extractAuto').isDisabled(), true, 'pause autocomplete remains local-only');
  assert.equal(await page.locator('#extractLists').isDisabled(), false);
  await page.locator('#extractLists').check();
  await page.getByRole('button', { name: 'Suggest tasks with cloud AI' }).click();
  await page.locator('#extractionReview').waitFor();
  assert.equal((await page.evaluate(async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).queue.length)), 0);
  assert.equal(await page.locator('#extractionItems [name=title]').inputValue(), 'Call Sam');
  await page.locator('#extractAccept').click();
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  assert.equal(ai.calls.length, 1);
  assert.match(ai.calls[0].messages[0].content, /Private list name/);
  assert.ok(!JSON.stringify(ai.calls[0]).includes('browser-secret'));

  await showView(page, 'work');
  await clickControl(page.getByRole('button', { name: 'Clarify Call Sam', exact: true }));
  await page.getByRole('button', { name: 'Action', exact: true }).click();
  await page.locator('#localGuidance summary').click();
  await page.getByRole('button', { name: 'Suggest with cloud AI' }).waitFor();
  await page.locator('[data-proposal=title]').fill('My draft answer');
  await page.getByRole('button', { name: 'Suggest with cloud AI' }).click();
  await page.locator('#guidanceUse').waitFor();
  assert.equal(await page.locator('[data-proposal=title]').inputValue(), 'My draft answer');
  assert.equal(await page.locator('#guidancePreview').textContent(), 'Phone Sam');
  await page.locator('#guidanceUse').click();
  assert.equal(await page.locator('[data-proposal=title]').inputValue(), 'Phone Sam');
  assert.equal(ai.calls.length, 2);
  await page.locator('#clarifyStop').click(); await showView(page, 'capture');
  ai.state.delay = true;
  await page.locator('#captureText').fill('Call Sam later');
  await page.getByRole('button', { name: 'Suggest tasks with cloud AI' }).click();
  await page.locator('#extractCancel').waitFor();
  await page.locator('#extractCancel').click(); ai.release();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#extractionReview').isVisible(), false);
  assert.equal(await page.locator('#captureText').inputValue(), 'Call Sam later');

  await page.locator('#captureText').fill('Call Sam after navigating');
  await page.getByRole('button', { name: 'Suggest tasks with cloud AI' }).click();
  await page.locator('#extractCancel').waitFor();
  await showView(page, 'work'); ai.release(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#extractionReview').isVisible(), false);
  await showView(page, 'capture');
  assert.equal(await page.locator('#captureText').inputValue(), 'Call Sam after navigating');

  await page.locator('#captureText').fill('Call Sam for Alice');
  await page.getByRole('button', { name: 'Suggest tasks with cloud AI' }).click();
  await page.locator('#extractCancel').waitFor();
  user = 'bob'; await clickControl(page.locator('#sync'));
  await page.waitForFunction(async () => (await (await import('/inbox-store.js?v=9')).transact(null)).accountId === 'bob');
  ai.release(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#extractionReview').isVisible(), false);
  assert.equal(await page.locator('#captureText').inputValue(), '');
  assert.equal(await page.evaluate(async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.capture.text), 'Call Sam for Alice');
});

test('a supported browser stays local and a signed-out local profile never requests cloud AI', { timeout: 30000 }, async t => {
  documents.length = 0;
  const ai = await provider(t);
  const previous = [process.env.AI_API_URL, process.env.AI_API_KEY, process.env.AI_MODEL];
  Object.assign(process.env, { AI_API_URL: ai.url, AI_API_KEY: 'browser-secret', AI_MODEL: 'test/model' });
  t.after(() => ["AI_API_URL", "AI_API_KEY", "AI_MODEL"].forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]));
  const app = await startServer({ browserUser: () => 'alice' }); t.after(app.close);
  const { page } = await browser(t, app, () => Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: {
    availability: async () => 'available', create: async () => ({ destroy() {}, prompt: async () => JSON.stringify({ items: [{ title: 'Local task', description: '', listId: '', priority: '', context: '', dueDate: '', dueTime: '', evidence: 'Local task', uncertainty: '' }], notes: '' }) })
  } }));
  const aiRequests = []; page.on('request', request => { if (request.url().includes('/api/v1/ai/')) aiRequests.push(request.url()); });
  await page.locator('#captureText').fill('Local task'); await page.locator('#captureAI summary').click(); await page.locator('#extractStart').click(); await page.locator('#extractionReview').waitFor();
  assert.equal(ai.calls.length, 0); assert.deepEqual(aiRequests, []);

  const signedOut = await startServer({ browserUser: () => null }); t.after(signedOut.close);
  const instance = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => instance.close());
  const localPage = await instance.newPage(); const localRequests = [];
  localPage.on('request', request => { if (request.url().includes('/api/v1/ai/')) localRequests.push(request.url()); });
  await localPage.goto(signedOut.url); await localPage.locator('#workspace').waitFor();
  await localPage.locator('#captureText').fill('Device-only task');
  await localPage.waitForTimeout(250);
  assert.deepEqual(localRequests, []);
  assert.equal(ai.calls.length, 0);
});
