import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';
import { clickControl } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { newFlow, flowProposal, membershipChange, itemFields, beforeFields } from '../../html/clarification-flow.js';
import { clarificationFields } from '../api/v1/clarification.mjs';
import { currentCreate } from './current-record.mjs';

const create = currentCreate;
const item = { type: 'item', id: 'capture', version: 1, title: 'Dad', description: 'Keep the full note', originalText: 'Dad\nCall Sunday', sourceUrl: 'https://example.com/dad', workspaceId: 'personal', status: 'inbox', collectionRefs: [] };
const createItem = (id, fields = {}) => create('item', id, { title: item.title, description: item.description, originalText: item.originalText,
  sourceUrl: item.sourceUrl, workspaceId: item.workspaceId, status: item.status, collectionRefs: [], ...fields });
const session = (step, decision, source = item) => ({ flowVersion: 3, step, decision, proposal: flowProposal(source) });
async function post(url, mutations, operationId = crypto.randomUUID(), accountId = 'alice') {
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json',
    'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: accountId, userRoles: ['authenticated'] })).toString('base64') },
  body: JSON.stringify({ apiVersion: 1, accountId, operationId, mutations }) });
  return { status: response.status, body: await response.json() };
}
const stored = (type, id = 'capture') => documents.find(doc => doc.UserID === 'alice' && doc.id === `record:${type}:${id}`)?.record;

test('v3 proposal helpers preserve membership and validate direct action fields', () => {
  assert.deepEqual(clarificationFields(newFlow(item)), newFlow(item));
  const filed = membershipChange(item, { type: 'project', id: 'home' });
  assert.deepEqual(filed, { collectionRefs: [{ type: 'project', id: 'home' }], listId: null, projectId: 'home' });
  assert.equal(membershipChange({ ...item, ...filed }, { type: 'project', id: 'home' }), null);
  assert.throws(() => itemFields(item, { ...flowProposal(item), view: 'action', status: 'waiting' }), /Waiting needs/);
  assert.throws(() => itemFields(item, { ...flowProposal(item), view: 'action', status: 'planned' }), /planned day/);
  assert.deepEqual(itemFields(item, { ...flowProposal(item), view: 'reference' }), { title: 'Dad', status: 'reference' });
});

test('v3 converts every common kind atomically, preserves source history, and creates draft projects', async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  await post(server.url, [create('list', 'family', { title: 'Family', kind: 'area' })]);
  for (const [index, kind] of ['project', 'area', 'role', 'list'].entries()) {
    const sourceId = `source-${index}`, targetId = `target-${index}`, source = { ...item, id: sourceId };
    assert.equal((await post(server.url, [createItem(sourceId)])).status, 200);
    const type = kind === 'project' ? 'project' : 'list', containerRef = { type, id: targetId }, parentRef = index === 1 ? { type: 'list', id: 'family' } : null;
    const decision = { type: 'convert', containerRef, containerKind: kind, parentRef, title: source.title };
    const fields = { title: source.title, description: source.description, originalText: source.originalText, sourceUrl: source.sourceUrl, workspaceId: 'personal', parentRef,
      ...(type === 'project' ? { outcome: '', status: 'draft' } : { kind }) };
    const batch = [create('clarification', sourceId, session('complete', decision, source)), { type, id: targetId, action: 'create', expectedVersion: 0, fields },
      { type: 'item', id: sourceId, action: 'delete', expectedVersion: 1 }];
    const operationId = crypto.randomUUID(), result = await post(server.url, batch, operationId);
    assert.equal(result.status, 200, JSON.stringify(result)); assert.deepEqual(await post(server.url, batch, operationId), result);
    assert.equal(stored('item', sourceId).deleted, true); assert.equal(stored(type, targetId).title, 'Dad');
    assert.equal(stored(type, targetId).originalText, source.originalText); assert.equal(stored(type, targetId).description, source.description);
    if (type === 'project') { assert.equal(stored(type, targetId).status, 'draft'); assert.equal(stored(type, targetId).outcome, ''); }
    assert.deepEqual(stored('clarification', sourceId).decision.containerRef, containerRef);
  }
});

test('v3 files without classifying, then saves a direct item decision with exact atomic validation', async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  await post(server.url, [create('list', 'family', { title: 'Family', kind: 'area' }), createItem('capture')]);
  let current = stored('item'), after = membershipChange(current, { type: 'list', id: 'family' });
  let decision = { type: 'file', destinationRef: { type: 'list', id: 'family' }, before: beforeFields(current, after), after };
  assert.equal((await post(server.url, [create('clarification', 'capture', session('classify', decision, current)),
    { type: 'item', id: 'capture', action: 'update', expectedVersion: 1, fields: after }])).status, 200);
  current = stored('item'); assert.equal(current.status, 'inbox'); assert.deepEqual(current.collectionRefs, [{ type: 'list', id: 'family' }]);
  after = itemFields(current, { ...flowProposal(current), view: 'action', title: 'Call Dad', status: 'waiting', waitingOn: 'Dad', reviewDate: '2026-10-12' });
  decision = { type: 'item', before: beforeFields(current, after), after };
  const clarification = { type: 'clarification', id: 'capture', action: 'update', expectedVersion: 1, fields: session('complete', decision, current) };
  const mutation = { type: 'item', id: 'capture', action: 'update', expectedVersion: 2, fields: after };
  const forged = structuredClone(mutation); forged.fields.status = 'completed';
  assert.equal((await post(server.url, [clarification, forged])).status, 400);
  assert.equal((await post(server.url, [clarification, mutation])).status, 200);
  assert.equal(stored('item').title, 'Call Dad'); assert.equal(stored('item').status, 'waiting'); assert.equal(stored('item').waitingOn, 'Dad');
});

test('conversion undo is version checked, atomic, and ordinary restore cannot bypass it', async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  await post(server.url, [createItem('capture')]);
  const decision = { type: 'convert', containerRef: { type: 'list', id: 'dad-role' }, containerKind: 'role', parentRef: null, title: 'Dad' };
  const forward = [create('clarification', 'capture', session('complete', decision)), create('list', 'dad-role', { title: 'Dad', kind: 'role', parentRef: null }),
    { type: 'item', id: 'capture', action: 'delete', expectedVersion: 1 }];
  assert.equal((await post(server.url, forward)).status, 200);
  assert.equal((await post(server.url, [{ type: 'item', id: 'capture', action: 'restore', expectedVersion: 2 }])).status, 400);
  const reverse = [{ type: 'clarification', id: 'capture', action: 'update', expectedVersion: 1, fields: session('reversed', decision) },
    { type: 'item', id: 'capture', action: 'restore', expectedVersion: 2 }, { type: 'list', id: 'dad-role', action: 'delete', expectedVersion: 1 }];
  faults.loseBatchResponse = true; const operationId = crypto.randomUUID(); assert.equal((await post(server.url, reverse, operationId)).status, 503);
  assert.equal((await post(server.url, reverse, operationId)).status, 200);
  assert.equal(stored('item').deleted, false); assert.equal(stored('list', 'dad-role').deleted, true); assert.equal(stored('clarification').step, 'reversed');
});

const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
test('mobile v3 clarification exposes destinations, converts in one tap, advances, and undoes', { timeout: 60000 }, async t => {
  documents.length = 0; const server = await startServer({ browserUser: true }); t.after(server.close);
  assert.equal((await post(server.url, [create('list', 'family', { title: 'Family', kind: 'area' }), createItem('capture'), createItem('second', { title: 'Call electrician', description: '', originalText: 'Call electrician', sourceUrl: null })], undefined, 'disposable-test-user')).status, 200);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  assert.equal(await (await fetch(server.url + '/clarification.js?v=5')).text(), await readFile(new URL('../../html/clarification.js', import.meta.url), 'utf8'));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage(), errors = [];
  await page.addInitScript(() => { window.__earlyErrors = []; addEventListener('error', event => window.__earlyErrors.push(`${event.filename}:${event.lineno}:${event.colno} ${event.message}`)); });
  page.on('pageerror', error => errors.push(error.stack || error.message)); t.after(() => assert.deepEqual(errors, []));
  page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
  await page.goto(server.url + '/#work'); await page.waitForTimeout(500); assert.deepEqual({ errors, early: await page.evaluate(() => window.__earlyErrors) }, { errors: [], early: [] }); await page.locator('#workspace').waitFor(); await confirmed(page);
  await clickControl(page.locator('#clarifyInbox')); await page.locator('#clarifier').waitFor();
  assert.equal(await page.locator('#clarifyProgress').textContent(), '1 of 2');
  assert.ok(await page.getByRole('button', { name: 'File Dad in Family' }).isVisible());
  await page.getByRole('button', { name: 'Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Use Family as parent' }).click();
  await page.locator('#clarifyFlow details > summary').click();
  await page.getByRole('button', { name: 'Make role under Family' }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('disposable-test-user')).draft.clarification?.item?.id === 'second');
  assert.equal(await page.locator('#clarifyProgress').textContent(), '2 of 2');
  await page.locator('[data-proposal="title"]').fill('Call licensed electrician');
  assert.ok(await page.getByRole('button', { name: 'Undo previous decision' }).isVisible());
  await page.getByRole('button', { name: 'Undo previous decision' }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyTask').textContent === 'Dad');
  await page.getByRole('button', { name: 'Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Use Family as parent' }).click();
  await page.locator('#clarifyFlow details > summary').click();
  await page.getByRole('button', { name: 'Make role under Family' }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyTask').textContent === 'Call electrician');
  assert.equal(await page.locator('[data-proposal="title"]').inputValue(), 'Call licensed electrician');
  await page.getByRole('button', { name: 'Undo previous decision' }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyTask').textContent === 'Dad');
  await confirmed(page);
  const source = documents.find(doc => doc.UserID === 'disposable-test-user' && doc.id === 'record:item:capture').record;
  const role = documents.find(doc => doc.UserID === 'disposable-test-user' && doc.id.startsWith('record:list:') && doc.record.kind === 'role').record;
  assert.equal(source.deleted, false); assert.equal(role.deleted, true);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.locator('#clarifier').evaluate(element => element.scrollWidth <= element.clientWidth));
  }
});

test('clarification preferences persist order and a custom alias dispatches its supported behavior', { timeout: 60000 }, async t => {
  documents.length = 0; const server = await startServer({ browserUser: true }); t.after(server.close);
  await post(server.url, [createItem('capture', { title: 'Groceries', description: '', originalText: 'Groceries', sourceUrl: null })], undefined, 'disposable-test-user');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor(); await confirmed(page);
  await clickControl(page.getByRole('button', { name: 'Preferences', exact: true, includeHidden: true }));
  const rows = page.locator('#clarifyActionPreferences > li');
  assert.deepEqual(await rows.locator('[data-field="label"]').evaluateAll(inputs => inputs.slice(0, 6).map(input => input.value)),
    ['Make project', 'Make list', 'Make checklist', 'Action', 'Reference', 'Someday']);
  await page.locator('#addClarifyAction [name="label"]').fill('Make shopping list');
  await page.locator('#addClarifyAction [name="behavior"]').selectOption('make-checklist');
  await page.locator('#addClarifyAction [type="submit"]').click();
  await page.reload(); await page.locator('#workspace').waitFor();
  await clickControl(page.getByRole('button', { name: 'Preferences', exact: true, includeHidden: true }));
  assert.equal(await page.locator('#clarifyActionPreferences [data-field="label"]').last().inputValue(), 'Make shopping list');
  await page.getByRole('button', { name: 'Close preferences', exact: true }).click();
  await clickControl(page.locator('#clarifyInbox')); await page.locator('#clarifier').waitFor();
  await page.getByRole('button', { name: 'Make shopping list', exact: true }).click();
  await waitForBrowser(page, async () => {
    const { transact, projected } = await import('/inbox-store.js?v=7');
    return Object.values(projected(await transact('disposable-test-user'))).some(record => record.type === 'list' && record.kind === 'checklist');
  });
  await confirmed(page);
  assert.equal(documents.find(doc => doc.UserID === 'disposable-test-user' && doc.id.startsWith('record:list:'))?.record.kind, 'checklist');
});

test('clarification skip advances, Parent saves membership, and the completed pass can restart skipped work', { timeout: 60000 }, async t => {
  documents.length = 0; const server = await startServer({ browserUser: true }); t.after(server.close);
  await post(server.url, [create('list', 'family', { title: 'Family', kind: 'area' }),
    createItem('capture', { title: 'Dad', description: '', originalText: 'Dad', sourceUrl: null }),
    createItem('second', { title: 'Call electrician', description: '', originalText: 'Call electrician', sourceUrl: null })], undefined, 'disposable-test-user');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor(); await confirmed(page);
  await clickControl(page.locator('#clarifyInbox')); await page.locator('#clarifier').waitFor();
  assert.equal(await page.locator('#clarifyTask').textContent(), 'Dad');
  await page.locator('#clarifySkip').click();
  await page.waitForFunction(() => document.querySelector('#clarifyTask').textContent === 'Call electrician');
  await page.getByRole('button', { name: 'Action', exact: true }).click();
  await page.getByRole('button', { name: 'Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Use Family as parent' }).click();
  await page.getByRole('button', { name: 'Save linked to Family', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyHeading').textContent === 'All inbox items viewed'); await confirmed(page);
  const second = documents.find(doc => doc.UserID === 'disposable-test-user' && doc.id === 'record:item:second').record;
  assert.deepEqual(second.collectionRefs, [{ type: 'list', id: 'family' }]); assert.equal(second.listId, 'family');
  await page.getByRole('button', { name: 'Return to first unprocessed item', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyTask').textContent === 'Dad');
  assert.equal(await page.locator('#clarifyProgress').textContent(), '1 of 1');
  await page.getByRole('button', { name: 'Reference', exact: true }).click();
  await page.getByRole('button', { name: 'Save without a new destination', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyHeading').textContent === 'Clarify inbox complete'); await confirmed(page);
  assert.equal(documents.find(doc => doc.UserID === 'disposable-test-user' && doc.id === 'record:item:capture').record.status, 'reference');
});
