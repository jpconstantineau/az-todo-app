import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldsFor } from '../api/v1/contract.mjs';
import { documents, startServer } from './harness.mjs';
import { cleanupExecutionPolicy, executionCount, retryExecutionCleanupMutations, transitionPolicy, validateExecutionPolicy } from '../../html/execution-policy.js';
import { currentCreate } from './current-record.mjs';
import { chromium } from 'playwright';
import { openPreference, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

const entry = (itemId, state = 'started', extra = {}) => ({ itemId, state, blockedReason: null, reviewDate: null,
  override: false, observedItemVersion: 1, ...extra });

test('execution policy contract bounds identity, uniqueness and blocked details', () => {
  assert.deepEqual(fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 2, entries: [] }),
    { workspaceId: 'personal', wipLimit: 2, entries: [] });
  for (const wipLimit of [0, 1, 20, 21, 50]) {
    const policy = { id: 'personal', workspaceId: 'personal', wipLimit, entries: [] };
    assert.equal(fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit, entries: [] }).wipLimit, wipLimit);
    assert.equal(validateExecutionPolicy(policy), policy);
  }
  for (const wipLimit of [-1, 51, 1.5, '0', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit, entries: [] }), /0 to 50/);
    assert.throws(() => validateExecutionPolicy({ id: 'personal', workspaceId: 'personal', wipLimit, entries: [] }), /0 to 50/);
  }
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', entries: [] }), /required/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1, entries: [entry('a'), entry('a')] }), /unique/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1,
    entries: [entry('a', 'blocked')] }), /reason/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1,
    entries: [entry('a', 'paused', { override: true })] }), /cannot retain a WIP override/);
  assert.throws(() => fieldsFor('executionPolicy', 'create', { workspaceId: 'personal', wipLimit: 1,
    entries: [entry('a', 'blocked', { blockedReason: 'Waiting', reviewDate: 'not-a-day' })] }), /valid .*calendar date/);
  assert.throws(() => fieldsFor('executionPolicy', 'update', { workspaceId: 'other' }), /immutable/);
  const many = { workspaceId: 'personal', wipLimit: 0, entries: Array.from({ length: 55 }, (_, index) => entry(`item-${index}`)) };
  assert.equal(fieldsFor('executionPolicy', 'create', many).entries.length, 55);
  assert.equal(validateExecutionPolicy({ id: 'personal', ...many }).entries.length, 55);
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
  const related = { type: 'reviewDecision', id: 'decision', action: 'create', expectedVersion: 0, fields: { choice: 'complete' } };
  assert.deepEqual(retryExecutionCleanupMutations([
    { type: 'item', id: 'task', action: 'update', expectedVersion: 7, fields: { status: 'completed' } }, related,
    { type: 'executionPolicy', id: 'personal', action: 'update', expectedVersion: 2, fields: { entries: [] } }
  ], records), [{ type: 'item', id: 'task', action: 'update', expectedVersion: 7, fields: { status: 'completed' } }, related]);
  assert.throws(() => retryExecutionCleanupMutations([
    { type: 'item', id: 'task', action: 'update', expectedVersion: 7, fields: { status: 'completed' } }
  ], { ...records, 'item:task': { ...item, version: 8 } }), /related record changed/);
  assert.throws(() => retryExecutionCleanupMutations([related], { ...records, 'reviewDecision:decision': { type: 'reviewDecision', id: 'decision', version: 1 } }), /related record changed/);
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
  let browserUser = 'alice';
  const server = await startServer({ browserUser: () => browserUser }); t.after(server.close);
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
  await page.goto(server.url);
  await page.locator('#workspace').waitFor(); await showView(page, 'execute');
  assert.equal(await page.locator('#activeLanes').isVisible(), false, 'empty lanes leave the ready queue in the initial mobile viewport');
  await page.locator('#executeList').selectOption('list');
  await openPreference(page, 'do');
  assert.equal(await page.locator('#preferencesDoHeading').evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('#doPreferenceScope').textContent(), 'Personal · Workspace');
  await page.locator('#wipLimit').fill('1'); await page.getByRole('button', { name: 'Save WIP limit' }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=18')).transact('alice');
    return local.queue.length === 0 && local.records['executionPolicy:personal']?.wipLimit === 1;
  });
  assert.equal(await page.locator('#preference-do-summary').textContent(), '0 of 1 WIP · Workspace');
  await showView(page, 'execute');
  const startAlpha = page.getByRole('button', { name: 'Start Alpha', exact: true });
  await startAlpha.focus(); await page.keyboard.press('Enter');
  await showView(page, 'execute');
  await page.getByRole('button', { name: 'Pause Alpha', exact: true }).waitFor();
  assert.equal(await page.locator('#activeLanes').isVisible(), true);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=18')).transact('alice')).queue.length === 0);
  assert.match(await page.locator('#wipCounter').innerText(), /1 of 1 WIP/);
  assert.equal(await page.locator('#preference-do-summary').textContent(), '1 of 1 WIP · Workspace');
  await showView(page, 'execute');
  const startBeta = page.getByRole('button', { name: 'Start Beta', exact: true });
  await startBeta.click(); await page.locator('#wipLimitDialog').waitFor(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Start Beta');
  await startBeta.click(); await page.getByRole('button', { name: 'Start anyway — override WIP limit' }).click();
  await showView(page, 'execute');
  await page.getByRole('button', { name: 'Pause Beta', exact: true }).waitFor();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=18')).transact('alice')).queue.length === 0);
  assert.match(await page.locator('#wipCounter').innerText(), /2 of 1 WIP.*override/i);
  await page.getByRole('button', { name: 'Block Alpha', exact: true }).click();
  await page.locator('#blockWorkDialog').waitFor({ state: 'visible' });
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
  await page.getByRole('button', { name: 'Resume Beta', exact: true }).waitFor();
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
  await showView(page, 'execute');
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Start Gamma', exact: true }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=18')).transact('alice');
    return local.queue.some(entry => entry.operation.mutations.some(mutation => mutation.type === 'executionPolicy' && mutation.fields.entries.some(value => value.itemId === 'gamma')));
  });
  await page.reload(); await page.locator('#workspace').waitFor();
  await showView(page, 'execute');
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
  await page.getByRole('button', { name: 'Return to ready Gamma', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Start Gamma');
  await showView(page, 'execute');
  await page.getByRole('button', { name: 'Start Gamma', exact: true }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=18')).transact('alice')).queue.length === 0);
  await showView(page, 'execute');
  await page.getByRole('button', { name: 'Block Gamma', exact: true }).click();
  await page.locator('#blockWorkForm textarea').fill('Alice private blocker');
  await context.setOffline(true); browserUser = 'bob'; await context.setOffline(false);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=18')).transact(null)).accountId === 'bob');
  assert.equal(await page.locator('#blockWorkDialog').getAttribute('open'), null);
  assert.doesNotMatch(await page.locator('body').innerText(), /Gamma|Alice private blocker/);
});

test('API supports 50 counted entries, unlimited work and ceiling-aware limit changes', { timeout: 30000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  let sequence = 0, version = 0;
  const post = async mutations => {
    const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: `limit-${++sequence}`, mutations }) });
    return { status: response.status, body: await response.json() };
  };
  const entries = Array.from({ length: 55 }, (_, i) => entry(`task-${i}`));
  for (let offset = 0; offset < entries.length; offset += 20) {
    const result = await post(entries.slice(offset, offset + 20).map(value => currentCreate('item', value.itemId, { title: value.itemId, status: 'next' })));
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  const create = await post([{ type: 'executionPolicy', id: 'personal', action: 'create', expectedVersion: 0,
    fields: { workspaceId: 'personal', wipLimit: 50, entries: entries.slice(0, 50) } }]);
  assert.equal(create.status, 200, JSON.stringify(create.body)); version = create.body.records[0].version;
  const change = async (fields, expectedStatus = 200, message) => {
    const result = await post([{ type: 'executionPolicy', id: 'personal', action: 'update', expectedVersion: version, fields }]);
    assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
    if (expectedStatus === 200) version = result.body.records[0].version;
    if (message) assert.match(result.body.message, message);
    return result;
  };
  await change({ entries: entries.slice(0, 51) }, 400, /explicit override/);
  const overridden = entries.slice(0, 52).map((value, i) => ({ ...value, override: i >= 50 }));
  await change({ entries: overridden });
  await change({ wipLimit: 50 }); // Same ceiling preserves valid overrides.
  await change({ wipLimit: 49 }, 400, /lowering/);
  await change({ wipLimit: 0 });
  await change({ entries }); // More than 50 entries, none with an override.
  await change({ wipLimit: 50 }, 400, /lowering/);
  await change({ entries: entries.slice(0, 2).map((value, i) => i ? { ...value, state: 'blocked', blockedReason: 'Dependency', reviewDate: '2030-01-03' } : value) });
  await change({ wipLimit: 1 }, 400, /lowering/);
  await change({ wipLimit: 2 });
  await change({ entries: [...entries.slice(0, 2), entry('task-2', 'started', { override: true }), entry('task-3', 'started', { override: true })] });
  await change({ wipLimit: 3 }); // Increasing while still over is valid.
  await change({ wipLimit: 3 });
  await change({ wipLimit: 2 }, 400, /lowering/);
  await change({ wipLimit: 0 });
  const oversized = await change({ entries: Array.from({ length: 60 }, (_, i) => entry(`task-${i}`, 'blocked', { blockedReason: 'x'.repeat(500), reviewDate: '2030-01-03' })) }, 400, /32 KiB/);
  assert.ok(oversized.body.message);
});

test('No limit persists in Preferences, permits Do transitions and retries against latest server work', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  let operation = 0;
  const post = async mutations => {
    const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: `unlimited-${++operation}`, mutations }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  await post([currentCreate('list', 'work', { title: 'Work' }), ...['one', 'two', 'three'].map(id => currentCreate('item', id, { title: id, status: 'next', listId: 'work' }))]);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  const confirmed = (limit, count) => waitForBrowser(page, async ([limit, count]) => {
    const local = await (await import('/inbox-store.js?v=21')).transact('alice'), policy = local.records['executionPolicy:personal'];
    return local.queue.length === 0 && policy?.wipLimit === limit && policy.entries.length === count;
  }, [limit, count]);
  const save = async limit => { await page.locator('#wipLimit').fill(String(limit)); await page.getByRole('button', { name: 'Save WIP limit', exact: true }).click(); };
  await page.goto(server.url); await showView(page, 'execute'); await page.locator('#executeList').selectOption('work');
  await page.setViewportSize({ width: 320, height: 844 });
  const readyBounds = await page.getByRole('button', { name: 'Start one', exact: true }).boundingBox();
  assert.ok(readyBounds.y + readyBounds.height <= 844, 'first ready action remains in the initial phone viewport');
  await page.getByRole('button', { name: 'Start one', exact: true }).click();
  await page.locator('#error').filter({ hasText: 'Choose and save a WIP limit' }).waitFor();
  await openPreference(page, 'do'); assert.equal(await page.locator('#wipLimit').inputValue(), '');
  await save(0); await confirmed(0, 0);
  assert.match(await page.locator('#executionPolicyStatus').textContent(), /No limit/);
  assert.equal(await page.locator('#preference-do-summary').textContent(), 'No limit · Workspace');
  await page.reload(); await page.locator('#wipLimit').waitFor(); assert.equal(await page.locator('#wipLimit').inputValue(), '0');
  await showView(page, 'execute');
  assert.equal(await page.locator('#execute a[href*="help"]').count(), 0);
  assert.equal(await page.locator('#execute').getByText(/^(Focus|Ready|Ready queue)$/).count(), 0);
  assert.equal(await page.locator('#execute').getByText('How Do chooses tasks', { exact: true }).count(), 0);
  for (const id of ['one', 'two']) { await page.getByRole('button', { name: `Start ${id}`, exact: true }).click(); await confirmed(0, id === 'one' ? 1 : 2); }
  assert.equal(await page.locator('#wipLimitDialog').isVisible(), false);
  assert.match(await page.locator('#wipCounter').textContent(), /2 WIP · No limit/);
  assert.doesNotMatch(await page.locator('#wipCounter').textContent(), /of 0|override active/);
  await page.getByRole('button', { name: 'Pause one', exact: true }).click(); await page.getByRole('button', { name: 'Resume one', exact: true }).click(); await confirmed(0, 2);
  await page.getByRole('button', { name: 'Block two', exact: true }).click();
  await page.locator('#blockWorkForm textarea').fill('Waiting'); await page.locator('#blockWorkForm input[type=date]').fill('2030-01-03');
  await page.getByRole('button', { name: 'Save block', exact: true }).click();
  await waitForBrowser(page, async () => { const local = await (await import('/inbox-store.js?v=21')).transact('alice'); return local.queue.length === 0 && local.records['executionPolicy:personal'].entries.some(e => e.itemId === 'two' && e.state === 'blocked' && !e.override); });
  await openPreference(page, 'do');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `settings fit at ${width}px`);
  }
  await save(1); await page.locator('#error').filter({ hasText: 'before lowering' }).waitFor(); await confirmed(0, 2);
  await save(2); await confirmed(2, 2);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true); await save(0);
  await waitForBrowser(page, async () => { const local = await (await import('/inbox-store.js?v=21')).transact('alice'); return local.queue.some(e => e.executionTransition?.kind === 'limit' && e.executionTransition.wipLimit === 0); });
  const latest = documents.find(row => row.id === 'record:executionPolicy:personal').record;
  await post([{ type: 'executionPolicy', id: 'personal', action: 'update', expectedVersion: latest.version,
    fields: { entries: [...latest.entries, entry('three', 'started', { override: true })] } }]);
  await context.setOffline(false);
  await waitForBrowser(page, async () => { const local = await (await import('/inbox-store.js?v=21')).transact('alice'); return !!local.queue[0]?.receipt && local.records['executionPolicy:personal']?.entries.length === 3; });
  await page.getByRole('button', { name: 'Retry against latest active work', exact: true }).click(); await confirmed(0, 3);
  await showView(page, 'execute'); assert.match(await page.locator('#wipCounter').textContent(), /3 WIP · No limit/);
  assert.doesNotMatch(await page.locator('#activeWork').textContent(), /WIP override|override active/);
  for (const id of ['one', 'two', 'three']) await page.getByRole('button', { name: `Return to ready ${id}`, exact: true }).click();
  await confirmed(0, 0); assert.equal(await page.locator('#activeWork').isVisible(), false);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Start three');
  await page.getByRole('button', { name: 'Start three', exact: true }).click(); await confirmed(0, 1);
  await page.getByRole('button', { name: 'Complete three', exact: true }).click(); await confirmed(0, 0);
  await page.waitForFunction(() => document.activeElement?.id === 'executeHeading');
  const help = await (await fetch(`${server.url}/help.html`)).text(); assert.match(help, /How Do chooses tasks/); assert.match(help, /0 for no limit, or 1–50/);
});
