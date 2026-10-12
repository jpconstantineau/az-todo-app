import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldsFor } from '../api/v1/contract.mjs';
import { documents, startServer } from './harness.mjs';
import { cleanupExecutionPolicy, executionCount, transitionPolicy } from '../../html/execution-policy.js';
import { currentCreate } from './current-record.mjs';
import { chromium } from 'playwright';
import { showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

const entry = (itemId, state = 'started', extra = {}) => ({ itemId, state, blockedReason: null, reviewDate: null,
  override: false, observedItemVersion: 1, ...extra });

test('execution policy contract bounds identity, uniqueness and blocked details', () => {
  assert.deepEqual(fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 2, entries: [] }),
    { workspaceId: 'personal', wipLimit: 2, entries: [] });
  for (const wipLimit of [0, 21, 1.5]) assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit, entries: [] }), /1 to 20/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1, entries: [entry('a'), entry('a')] }), /unique/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1,
    entries: [entry('a', 'blocked')] }), /reason/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1,
    entries: [entry('a', 'paused', { override: true })] }), /cannot retain a WIP override/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1,
    entries: [entry('a', 'blocked', { blockedReason: 'Waiting', reviewDate: 'not-a-day' })] }), /valid .*calendar date/);
  assert.throws(() => fieldsFor('executionPolicy', 'update', { workspaceId: 'other' }), /immutable/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1,
    entries: Array.from({ length: 41 }, (_, index) => entry(`item-${index}`)) }), /at most 40/);
});

test('browser policy transitions preserve canonical item fields and terminal cleanup is shared', () => {
  const item = { id: 'task', type: 'item', version: 7, workspaceId: 'personal', status: 'next', title: 'Ship',
    plannedDay: '2030-01-02', dueDate: '2030-01-10', projectId: 'project', collectionRefs: [{ type: 'project', id: 'project' }] };
  const policy = { type: 'executionPolicy', id: 'personal', workspaceId: 'personal', version: 1, wipLimit: 1, entries: [] };
  const started = transitionPolicy(policy, item, 'started');
  assert.equal(executionCount(started), 1);
  assert.deepEqual(item, { id: 'task', type: 'item', version: 7, workspaceId: 'personal', status: 'next', title: 'Ship',
    plannedDay: '2030-01-02', dueDate: '2030-01-10', projectId: 'project', collectionRefs: [{ type: 'project', id: 'project' }] });
  const blocked = transitionPolicy(started, item, 'blocked', { reason: 'Vendor response', reviewDate: '2030-01-03' });
  assert.equal(executionCount(blocked), 1); assert.equal(blocked.entries[0].blockedReason, 'Vendor response');
  const paused = transitionPolicy(blocked, item, 'paused'); assert.equal(executionCount(paused), 0); assert.equal(paused.entries[0].override, false);
  const records = { 'item:task': item, 'executionPolicy:personal': { ...started, version: 2 } };
  for (const mutation of [
    { type: 'item', id: 'task', action: 'update', expectedVersion: 7, fields: { status: 'completed' } },
    { type: 'item', id: 'task', action: 'update', expectedVersion: 7, fields: { status: 'reference' } },
    { type: 'item', id: 'task', action: 'delete', expectedVersion: 7 }
  ]) {
    const cleanup = cleanupExecutionPolicy(records, [mutation]);
    assert.deepEqual(cleanup[0].itemIds, ['task']); assert.deepEqual(cleanup[0].mutation.fields.entries, []);
  }
});

test('API serializes concurrent starts, requires explicit override and isolates workspace ownership', { timeout: 30000 }, async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  const post = async (operationId, mutations) => {
    const principal = Buffer.from(JSON.stringify({ userId: 'alice', userRoles: ['authenticated'] })).toString('base64');
    const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json', 'x-ms-client-principal': principal },
      body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId, mutations }) });
    return { status: response.status, body: await response.json() };
  };
  const setup = await post('execution-setup', [
    currentCreate('workspace', 'other', { title: 'Other' }),
    currentCreate('item', 'first', { title: 'First', status: 'next' }),
    currentCreate('item', 'second', { title: 'Second', status: 'next' }),
    currentCreate('item', 'foreign', { title: 'Foreign', status: 'next', workspaceId: 'other' }),
    { type: 'executionPolicy', id: 'personal', action: 'create', expectedVersion: 0,
      fields: { workspaceId: 'personal', wipLimit: 1, entries: [entry('first')] } }
  ]);
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const noOverride = await post('execution-no-override', [{ type: 'executionPolicy', id: 'personal', action: 'update', expectedVersion: 1,
    fields: { entries: [entry('first'), entry('second')] } }]);
  assert.equal(noOverride.status, 400); assert.match(noOverride.body.message, /explicit override/);
  const overrideFields = { entries: [entry('first'), entry('second', 'started', { override: true })] };
  const winnerAndConflict = await Promise.all([
    post('execution-device-a', [{ type: 'executionPolicy', id: 'personal', action: 'update', expectedVersion: 1, fields: overrideFields }]),
    post('execution-device-b', [{ type: 'executionPolicy', id: 'personal', action: 'update', expectedVersion: 1,
      fields: { entries: [entry('first', 'blocked', { blockedReason: 'Dependency', reviewDate: '2030-01-03' })] } }])
  ]);
  assert.deepEqual(winnerAndConflict.map(result => result.status).sort(), [200, 409]);
  assert.equal(winnerAndConflict.find(result => result.status === 409).body.status, 'conflict');
  const policyVersion = winnerAndConflict.find(result => result.status === 200).body.records[0].version;
  const foreign = await post('execution-foreign', [{ type: 'executionPolicy', id: 'personal', action: 'update', expectedVersion: policyVersion,
    fields: { entries: [entry('foreign')] } }]);
  assert.equal(foreign.status, 400); assert.match(foreign.body.message, /this workspace/);
  const identity = documents.find(row => row.id === 'record:item:first').record;
  assert.equal(identity.status, 'next'); assert.equal(identity.workspaceId, 'personal'); assert.equal(identity.version, 1);
});

test('Do exposes keyboard and touch transitions, explicit WIP choices, terminal cleanup and offline replay', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: 'execution-browser-setup', mutations: [
      currentCreate('list', 'list', { title: 'Delivery' }),
      currentCreate('project', 'project', { title: 'Launch', outcome: 'Shipped' }),
      ...[['alpha', '2030-02-01'], ['beta', '2030-02-02'], ['gamma', '2030-02-03']].map(([id, plannedDay]) => currentCreate('item', id,
        { title: id[0].toUpperCase() + id.slice(1), status: id === 'alpha' ? 'inbox' : 'next', listId: 'list', projectId: 'project', plannedDay, dueDate: '2030-03-01' }))
    ] }) });
  assert.equal(response.status, 200, await response.text());
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.waitForTimeout(1000); assert.deepEqual(errors, []);
  if (await page.locator('#workspace').isHidden()) throw new Error(`Workspace stayed hidden: ${await page.locator('#loginStatus').textContent()} ${await page.locator('#error').textContent()}`);
  await page.locator('#workspace').waitFor(); await showView(page, 'execute');
  await page.locator('#executeList').selectOption('list');
  await page.locator('#wipLimit').fill('1'); await page.getByRole('button', { name: 'Save WIP limit' }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=18')).transact('alice');
    return local.queue.length === 0 && local.records['executionPolicy:personal']?.wipLimit === 1;
  });
  const startAlpha = page.getByRole('button', { name: 'Start Alpha', exact: true });
  await startAlpha.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Pause Alpha', exact: true }).waitFor();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=18')).transact('alice')).queue.length === 0);
  assert.match(await page.locator('#wipCounter').innerText(), /1 of 1 WIP/);
  const startBeta = page.getByRole('button', { name: 'Start Beta', exact: true });
  await startBeta.click(); await page.locator('#wipLimitDialog').waitFor(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Start Beta');
  await startBeta.click(); await page.getByRole('button', { name: 'Start anyway — override WIP limit' }).click();
  await page.getByRole('button', { name: 'Pause Beta', exact: true }).waitFor();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=18')).transact('alice')).queue.length === 0);
  assert.match(await page.locator('#wipCounter').innerText(), /2 of 1 WIP.*override/i);
  await page.getByRole('button', { name: 'Block Alpha', exact: true }).click();
  await page.locator('#blockWorkForm textarea').fill('Waiting for vendor');
  const reviewDay = await page.evaluate(() => {
    const now = new Date(), pad = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  });
  await page.locator('#blockWorkForm input[type=date]').fill(reviewDay);
  await page.getByRole('button', { name: 'Save block' }).click();
  await page.getByText('Reason: Waiting for vendor', { exact: false }).waitFor();
  await waitForBrowser(page, async () => { const local = await (await import('/inbox-store.js?v=18')).transact('alice'); return local.queue.length === 0 || !!local.queue[0]?.failure; });
  const blockQueue = await page.evaluate(async () => (await (await import('/inbox-store.js?v=18')).transact('alice')).queue);
  if (blockQueue.length) throw new Error(`Block sync failed: ${JSON.stringify(blockQueue[0])}`);
  await showView(page, 'reviews'); await page.locator('#startDaily').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=18')).transact('alice')).queue.length === 0);
  const daily = documents.find(row => row.kind === 'record' && row.record.type === 'review' && row.record.reviewKind === 'daily')?.record;
  assert.ok(daily?.included.some(value => value.type === 'item' && value.id === 'alpha'), 'due blocked work enters the daily review');
  const alphaReviewValue = await page.locator('#reviewRecord option').evaluateAll(options => options.find(option => option.textContent.includes('Alpha'))?.value);
  await page.locator('#reviewRecord').selectOption(alphaReviewValue);
  assert.match(await page.locator('#reviewDetails').textContent(), /Blocked reason: Waiting for vendor.*Counts toward WIP/s);
  await showView(page, 'execute');
  await page.getByRole('button', { name: 'Pause Beta', exact: true }).click();
  await page.waitForTimeout(500);
  if (!await page.getByRole('button', { name: 'Resume Beta', exact: true }).count()) throw new Error(`Pause failed: ${await page.locator('#executionStatus').textContent()} ${await page.locator('#error').textContent()} ${await page.locator('#activeWork').innerText()}`);
  await page.getByRole('button', { name: 'Resume Beta', exact: true }).click();
  await page.locator('#wipLimitDialog').waitFor();
  await page.getByRole('button', { name: 'Pause Alpha and start Beta', exact: true }).click();
  await page.getByRole('button', { name: 'Complete Beta', exact: true }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=18')).transact('alice');
    return local.queue.length === 0 && local.records['item:beta']?.status === 'completed' &&
      !local.records['executionPolicy:personal']?.entries.some(entry => entry.itemId === 'beta');
  });
  const beta = documents.find(row => row.id === 'record:item:beta').record;
  assert.equal(beta.plannedDay, '2030-02-02'); assert.equal(beta.dueDate, '2030-03-01');
  assert.equal(beta.projectId, 'project'); assert.equal(beta.listId, 'list');
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Start Gamma', exact: true }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=18')).transact('alice');
    return local.queue.some(entry => entry.operation.mutations.some(mutation => mutation.type === 'executionPolicy' && mutation.fields.entries.some(value => value.itemId === 'gamma')));
  });
  await page.reload(); await page.locator('#workspace').waitFor();
  await page.getByRole('button', { name: 'Pause Gamma', exact: true }).waitFor();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}px`);
  }
  const targetHeights = await page.locator('#activeWork button:visible').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
  assert.ok(targetHeights.length && targetHeights.every(height => height >= 44));
  await context.setOffline(false);
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=18')).transact('alice');
    return local.queue.length === 0 && local.records['executionPolicy:personal']?.entries.some(value => value.itemId === 'gamma');
  });
});
