import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { destination, captureOperation, committedReceipt } from '../../html/handoff-protocol.js';

const extensionId = 'a'.repeat(32), ticket = 'b'.repeat(32);
const capture = () => ({ apiVersion: 1, accountId: 'alice', operationId: 'capture-operation', mutations: [
  { type: 'item', id: 'capture-item', action: 'create', expectedVersion: 0, fields: {
    title: 'Read the article', description: 'Compare the examples', originalText: '  Read the article\nwith its examples.  ',
    sourceTitle: 'An article', sourceUrl: 'https://example.com/article', selectedText: 'Selected passage\nsecond line'
  } }
] });

test('handoff accepts only bounded original capture creates for the verified account', () => {
  const original = capture();
  assert.deepEqual(captureOperation(original, 'alice'), original);
  assert.notEqual(captureOperation(original, 'alice'), original);
  assert.deepEqual(destination('#extension=' + extensionId + '&ticket=' + ticket), { extensionId, ticket });
  for (const hash of ['', '#extension=' + extensionId, '#extension=' + extensionId + '&ticket=' + ticket + '&text=private', '#extension=https://evil.example&ticket=' + ticket]) assert.throws(() => destination(hash));
  for (const change of [
    o => { o.accountId = 'bob'; }, o => { o.extra = true; }, o => { o.operationId = '../bad'; },
    o => { o.mutations.push(structuredClone(o.mutations[0])); }, o => { o.mutations[0].type = 'list'; },
    o => { o.mutations[0].action = 'update'; }, o => { o.mutations[0].expectedVersion = 1; },
    o => { o.mutations[0].fields.title = ' '; }, o => { o.mutations[0].fields.title = 'x'.repeat(201); },
    o => { o.mutations[0].fields.originalText = 'x'.repeat(16001); }, o => { o.mutations[0].fields.selectedText = 'x'.repeat(8001); },
    o => { o.mutations[0].fields.description = '\u0000'; }, o => { o.mutations[0].fields.listId = 'foreign'; },
    o => { o.mutations[0].fields.sourceUrl = 'javascript:alert(1)'; }, o => { o.mutations[0].fields.sourceUrl = 'https://user:secret@example.com'; },
    o => { o.mutations[0].fields.originalText = '界'.repeat(16000); o.mutations[0].fields.selectedText = '界'.repeat(8000); }
  ]) { const value = capture(); change(value); assert.throws(() => captureOperation(value, 'alice')); }
});

test('acknowledgements require a committed receipt for the exact account, operation and content', () => {
  const operation = capture(), mutation = operation.mutations[0];
  const receipt = { apiVersion: 1, accountId: 'alice', operationId: operation.operationId, sequence: 1, status: 'committed',
    records: [{ ...mutation.fields, type: 'item', id: mutation.id, accountId: 'alice', version: 1, deleted: false }] };
  assert.equal(committedReceipt(receipt, operation).itemId, mutation.id);
  for (const change of [
    r => { r.accountId = 'bob'; }, r => { r.operationId = 'other'; }, r => { r.status = 'conflict'; },
    r => { r.records[0].title = 'different'; }, r => { r.records[0].deleted = true; },
    r => { r.records[0].version = 2; }, r => { r.records[0].accountId = 'bob'; }, r => { r.records = []; }
  ]) { const value = structuredClone(receipt); change(value); assert.throws(() => committedReceipt(value, operation)); }
});

async function setup(t, mode = {}) {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ operation, mode }) => {
    window.bridgeMode = mode; window.bridgeCalls = []; window.pendingCapture = operation;
    window.chrome ??= {};
    Object.defineProperty(window.chrome, 'runtime', { configurable: true, value: mode.absent ? undefined : {
      sendMessage(id, message, callback) {
        bridgeCalls.push({ id, message });
        const reply = { ...message };
        if (message.type === 'preview') reply.operation = pendingCapture;
        else { delete reply.receipt; reply.acknowledged = !bridgeMode.loseAck; }
        if (bridgeMode.wrongRequest) reply.requestId = 'wrong';
        if (bridgeMode.wrongTicket) reply.ticket = 'wrong';
        if (bridgeMode.wrongAccount) reply.accountId = 'bob';
        if (bridgeMode.delay && message.type === 'preview') window.finishBridge = () => callback(reply);
        else callback(reply);
      }
    } });
  }, { operation: capture(), mode });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('Handoff page error:', error.message));
  await page.route('**/.auth/me', route => route.fulfill({ json: { clientPrincipal: { userId: user, userDetails: 'Alice Example' } } }));
  await page.goto(server.url + '/handoff.html#extension=' + extensionId + '&ticket=' + ticket);
  return { page, context, browser, server, setUser: value => { user = value; } };
}
async function preview(page) {
  await page.getByRole('button', { name: 'Preview saved capture' }).click();
  await page.locator('#handoffCapture:visible, #handoffError:visible').waitFor();
  assert.equal(await page.locator('#handoffError').isVisible(), false, await page.locator('#handoffError').textContent());
}
const saved = () => documents.filter(d => d.kind === 'record');
const waitError = page => page.locator('#handoffError').waitFor();

test('explicit preview and save preserve source text, use the v1 API and acknowledge only one import', async t => {
  const { page, server, browser } = await setup(t);
  const urls = []; page.on('request', request => urls.push(request.url()));
  assert.equal(await page.evaluate(() => bridgeCalls.length), 0);
  // Arbitrary page/iframe postMessage payloads have no receiving bridge.
  await page.evaluate(operation => window.postMessage({ operation }, location.origin), capture());
  assert.equal(saved().length, 0);
  await preview(page);
  assert.equal(saved().length, 0);
  assert.equal(await page.locator('#handoffOriginal').inputValue(), capture().mutations[0].fields.originalText);
  assert.match(await page.locator('#handoffAccount').textContent(), /Alice Example/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'handoffTitle');
  if (process.env.HANDOFF_SCREENSHOTS) {
    await mkdir(process.env.HANDOFF_SCREENSHOTS, { recursive: true });
    console.log('Handoff browser:', browser.version());
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: process.env.HANDOFF_SCREENSHOTS + '/handoff-' + theme + '-' + width + '.png', fullPage: true });
    }
  }
  await page.getByRole('button', { name: 'Save to my inbox' }).dblclick();
  await page.waitForFunction(() => document.querySelector('#handoffStatus').textContent.startsWith('Imported and acknowledged'));
  assert.equal(saved().length, 1);
  for (const [key, value] of Object.entries(capture().mutations[0].fields)) assert.equal(saved()[0].record[key], value);
  const calls = await page.evaluate(() => bridgeCalls);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.id === extensionId));
  assert.equal(calls[1].message.receipt.status, 'committed'); assert.equal(calls[1].message.receipt.itemId, 'capture-item');
  assert.ok(!JSON.stringify(calls[1].message).includes('Selected passage'));
  assert.ok(urls.every(url => !url.includes('Read') && !url.includes('Selected') && !url.includes('alice')));
  await page.goto(server.url);
  await page.locator('#workspace').waitFor(); await page.locator('a[href="#work"]').click();
  await page.getByRole('button', { name: 'Edit Read the article', exact: true }).waitFor();
});

for (const kind of ['response', 'acknowledgement']) test('lost ' + kind + ' retries the identical operation without duplicate creation', async t => {
  const { page } = await setup(t, { loseAck: kind === 'acknowledgement' });
  if (kind === 'response') await page.route('**/api/v1/operations', async route => {
    await route.fetch(); await route.abort();
  }, { times: 1 });
  await preview(page); await page.locator('#handoffSave').click(); await waitError(page);
  assert.equal(saved().length, 1);
  await page.evaluate(() => { bridgeMode.loseAck = false; });
  await preview(page); await page.locator('#handoffSave').click();
  await page.waitForFunction(() => document.querySelector('#handoffStatus').textContent.startsWith('Imported and acknowledged'));
  assert.equal(saved().length, 1); assert.equal(documents.filter(d => d.kind === 'receipt').length, 1);
});

for (const mode of [{ absent: true }, { wrongRequest: true }, { wrongTicket: true }, { wrongAccount: true }]) test('invalid bridge stays closed: ' + JSON.stringify(mode), async t => {
  const { page } = await setup(t, mode);
  await page.locator('#handoffPreview').click(); await waitError(page);
  assert.equal(saved().length, 0); assert.equal(await page.locator('#handoffCapture').isVisible(), false);
});

test('account switching and logout before save retain capture and prevent writes', async t => {
  const { page, setUser } = await setup(t);
  for (const user of ['bob', null]) {
    setUser('alice'); await preview(page); setUser(user);
    await page.locator('#handoffSave').click(); await waitError(page);
    assert.equal(saved().length, 0); assert.equal(await page.locator('#handoffOriginal').inputValue(), '');
  }
  assert.equal(await page.locator('#handoffSignIn').isVisible(), true);
  assert.equal(await page.evaluate(() => bridgeCalls.filter(c => c.message.type === 'acknowledge').length), 0);
});

test('account switching during preview discards the delayed payload', async t => {
  const { page, setUser } = await setup(t, { delay: true });
  await page.locator('#handoffPreview').click(); await page.waitForFunction(() => !!window.finishBridge);
  setUser('bob'); await page.evaluate(() => finishBridge()); await waitError(page);
  assert.equal(await page.locator('#handoffOriginal').inputValue(), ''); assert.equal(saved().length, 0);
});

test('offline save and cancellation leave the extension copy unacknowledged', async t => {
  const { page, context } = await setup(t);
  await preview(page); await context.setOffline(true);
  await page.locator('#handoffSave').click(); await waitError(page);
  assert.equal(saved().length, 0);
  await context.setOffline(false); await preview(page); await page.locator('#handoffCancel').click();
  assert.equal(await page.locator('#handoffCapture').isVisible(), false);
  assert.equal(await page.evaluate(() => bridgeCalls.filter(c => c.message.type === 'acknowledge').length), 0);
});

test('changed-content retries cannot acknowledge a previous receipt or resurrect deleted captures', async t => {
  const { page } = await setup(t, { loseAck: true });
  await preview(page); await page.locator('#handoffSave').click(); await waitError(page);
  await page.evaluate(() => { pendingCapture.mutations[0].fields.title = 'Changed'; bridgeMode.loseAck = false; });
  await preview(page); await page.locator('#handoffSave').click(); await waitError(page);
  assert.match(await page.locator('#handoffError').textContent(), /conflicts/);
  assert.equal(saved()[0].record.title, 'Read the article');
  await page.evaluate(async () => {
    await fetch('/api/v1/operations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      apiVersion: 1, accountId: 'alice', operationId: 'delete-item', mutations: [{ type: 'item', id: 'capture-item', action: 'delete', expectedVersion: 1 }]
    }) });
    pendingCapture.mutations[0].fields.title = 'Read the article';
  });
  await preview(page); await page.locator('#handoffSave').click();
  await page.waitForFunction(() => document.querySelector('#handoffStatus').textContent.startsWith('Imported and acknowledged'));
  assert.equal(saved()[0].record.deleted, true); assert.equal(saved()[0].record.version, 2);
});

test('untrusted titles and source labels render as text and session responses are never cached', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => { pendingCapture.mutations[0].fields.title = '<img src=x onerror="window.injected=1">'; });
  await preview(page);
  assert.equal(await page.locator('#handoffTitle img').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.deepEqual(await page.evaluate(() => caches.keys()), []);
});

test('unpacked MV3 messaging binds the actual handoff tab and rejects other tabs and paths', async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const extensionPath = fileURLToPath(new URL('./fixtures/handoff-extension/', import.meta.url));
  // Playwright's Chromium supports extension loading in the new headless mode.
  const context = await chromium.launchPersistentContext('', { channel: 'chromium',
    args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath] });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const pageReady = context.waitForEvent('page');
  const handoffUrl = await worker.evaluate(({ operation, origin }) => openHandoff(operation, origin), { operation: capture(), origin: server.url });
  const page = await pageReady;
  await page.waitForURL(handoffUrl);
  await preview(page);
  const imposter = await context.newPage(); await imposter.goto(handoffUrl);
  await imposter.locator('#handoffPreview').click(); await waitError(imposter);
  assert.equal(saved().length, 0);
  await imposter.goto(server.url + '/help.html');
  const rejected = await imposter.evaluate(async ({ extensionId, ticket }) => chrome.runtime.sendMessage(extensionId, {
    protocol: 'taskgem-handoff-v1', type: 'preview', ticket, requestId: crypto.randomUUID(), accountId: 'alice'
  }), destination(new URL(handoffUrl).hash));
  assert.equal(rejected.error, 'untrusted_sender');
  await page.bringToFront();
  // Backgrounding clears the page preview, while the extension keeps its durable copy.
  await page.reload(); await preview(page); await page.locator('#handoffSave').click();
  await page.waitForFunction(() => document.querySelector('#handoffStatus').textContent.startsWith('Imported and acknowledged'));
  assert.equal(saved().length, 1);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('pending')).pending), undefined);
});
