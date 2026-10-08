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
test('mobile clarification uses the staged parent picker, resumes its draft, converts, and undoes', { timeout: 60000 }, async t => {
  documents.length = 0; const server = await startServer({ browserUser: true }); t.after(server.close);
  assert.equal((await post(server.url, [create('list', 'family', { title: 'Family', kind: 'area' }), createItem('capture'), createItem('second', { title: 'Call electrician', description: '', originalText: 'Call electrician', sourceUrl: null })], undefined, 'disposable-test-user')).status, 200);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  assert.equal(await (await fetch(server.url + '/clarification.js?v=9')).text(), await readFile(new URL('../../html/clarification.js', import.meta.url), 'utf8'));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage(), errors = [];
  await page.addInitScript(() => { window.__earlyErrors = []; addEventListener('error', event => window.__earlyErrors.push(`${event.filename}:${event.lineno}:${event.colno} ${event.message}`)); });
  page.on('pageerror', error => errors.push(error.stack || error.message)); t.after(() => assert.deepEqual(errors, []));
  page.on('requestfailed', request => errors.push(`${request.url()} ${request.failure()?.errorText}`));
  await page.goto(server.url + '/#work'); await page.waitForTimeout(500); assert.deepEqual({ errors, early: await page.evaluate(() => window.__earlyErrors) }, { errors: [], early: [] }); await page.locator('#workspace').waitFor(); await confirmed(page);
  await clickControl(page.locator('#clarifyInbox')); await page.locator('#clarifier').waitFor();
  assert.equal(await page.locator('#clarifyProgress').textContent(), '1 of 2');
  assert.equal(await page.locator('#clarifyHeading').textContent(), 'Clarifying');
  assert.equal(await page.getByRole('textbox', { name: 'Item title' }).count(), 1);
  assert.equal(await page.locator('#clarifyQuestion').evaluate(element => element.nextElementSibling.className), 'clarify-grid');
  assert.equal(await page.getByText('One item at a time', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Destination mode', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'File item', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Parent', exact: true }).count(), 0);
  assert.deepEqual(await page.locator('.clarify-footer > button').allTextContents(), ['Save', 'Skip', 'Stop']);
  assert.equal(await page.locator('#clarifySave').isDisabled(), true);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.locator('#clarifier').evaluate(element => element.scrollWidth <= element.clientWidth));
    assert.ok((await page.locator('.clarify-footer button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height))).every(height => height >= 44));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Use Family as parent' }).click();
  assert.equal(await page.locator('#clarifySave').isDisabled(), false);
  await page.locator('#clarifySave').click();
  await waitForBrowser(page, async () => {
    const { projected, transact } = await import('/inbox-store.js?v=9'), state = await transact('disposable-test-user');
    return projected(state)['item:capture']?.collectionRefs?.some(ref => ref.type === 'list' && ref.id === 'family');
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.locator('#clarifySave').isDisabled(), true);
  await page.locator('#clarifyFlow details > summary').click();
  await page.getByRole('button', { name: 'Make role under Family' }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('disposable-test-user')).draft.clarification?.item?.id === 'second');
  assert.equal(await page.locator('#clarifyProgress').textContent(), '2 of 2');
  await page.getByRole('textbox', { name: 'Item title' }).fill('Call licensed electrician');
  await page.getByRole('button', { name: 'Use Family as parent' }).click();
  await waitForBrowser(page, async () => {
    const draft = (await (await import('/inbox-store.js?v=9')).transact('disposable-test-user')).draft.clarification;
    return draft?.open === true && draft.proposal.title === 'Call licensed electrician' && draft.proposal.parentRef?.id === 'family';
  });
  await page.reload(); await page.locator('#workspace').waitFor(); await page.locator('#clarifier').waitFor();
  await page.waitForFunction(() => document.querySelector('#clarifyTitle').value === 'Call licensed electrician');
  assert.equal(await page.getByRole('textbox', { name: 'Item title' }).inputValue(), 'Call licensed electrician');
  assert.equal(await page.getByRole('button', { name: 'Use Family as parent' }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'No parent', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'No parent', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#clarifySave').isDisabled(), true);
  await page.locator('#clarifyFlow details > summary').click();
  await page.getByRole('button', { name: 'Make role', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyQuestion').textContent === 'Session summary'); await confirmed(page);
  const roles = documents.filter(doc => doc.UserID === 'disposable-test-user' && doc.id.startsWith('record:list:') && doc.record.kind === 'role').map(doc => doc.record);
  assert.deepEqual(roles.map(role => [role.title, role.parentRef]).sort(), [['Call licensed electrician', null], ['Dad', { type: 'list', id: 'family' }]]);
  await page.getByRole('button', { name: 'Undo previous decision' }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyTitle').value === 'Call electrician');
  await confirmed(page);
  assert.equal(documents.find(doc => doc.UserID === 'disposable-test-user' && doc.id === 'record:item:second').record.deleted, false);
  assert.equal(documents.find(doc => doc.UserID === 'disposable-test-user' && doc.record?.title === 'Call licensed electrician').record.deleted, true);
});

test('clarification redraws preserve panel and destination scroll with logical focus', { timeout: 60000 }, async t => {
  documents.length = 0; const server = await startServer({ browserUser: true }); t.after(server.close);
  const collections = Array.from({ length: 24 }, (_, index) => create('list', `destination-${index}`, { title: `Destination ${String(index).padStart(2, '0')}`, kind: 'list' }));
  assert.equal((await post(server.url, collections.slice(0, 12), undefined, 'disposable-test-user')).status, 200);
  assert.equal((await post(server.url, collections.slice(12), undefined, 'disposable-test-user')).status, 200);
  assert.equal((await post(server.url, [createItem('capture')], undefined, 'disposable-test-user')).status, 200);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 560 } });
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor(); await confirmed(page);
  await clickControl(page.locator('#clarifyInbox')); await page.getByRole('button', { name: 'Action', exact: true }).click();
  const position = async (panel, destinations) => page.evaluate(({ panel, destinations }) => {
    const dialog = document.querySelector('#clarifier'), list = document.querySelector('.clarify-destinations');
    dialog.scrollTop = panel; list.scrollTop = destinations;
    return { panel: dialog.scrollTop, destinations: list.scrollTop };
  }, { panel, destinations });
  const state = () => page.evaluate(() => {
    const dialog = document.querySelector('#clarifier'), list = document.querySelector('.clarify-destinations');
    return { panel: dialog.scrollTop, panelMax: dialog.scrollHeight - dialog.clientHeight,
      destinations: list.scrollTop, destinationsMax: list.scrollHeight - list.clientHeight,
      focus: document.activeElement.dataset.focusKey || document.activeElement.textContent };
  });
  const assertPreserved = async (before, focus) => {
    const after = await state();
    assert.ok(Math.abs(after.panel - Math.min(before.panel, after.panelMax)) <= 1);
    assert.ok(Math.abs(after.destinations - Math.min(before.destinations, after.destinationsMax)) <= 1);
    assert.equal(after.focus, focus);
  };

  let before = await position(80, 80); assert.ok(before.panel > 0 && before.destinations > 0);
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await assertPreserved(before, 'status:planned');

  before = await position(550, 100);
  await page.evaluate(() => {
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function(options) {
      focus.call(this, options);
      if (this.dataset.focusKey?.startsWith('destination:')) queueMicrotask(() => { document.querySelector('#clarifier').scrollTop -= 36; });
    };
  });
  await page.locator('.clarify-destinations .clarify-destination').nth(3).click();
  await assertPreserved(before, 'destination:list:destination-2');

  const noParent = page.getByRole('button', { name: 'No parent', exact: true });
  await noParent.focus();
  before = await position(550, 5);
  await noParent.press('Enter');
  await assertPreserved(before, 'destination:none');

  before = await position(60, 60);
  await page.getByRole('button', { name: 'Back to choices', exact: true }).click();
  await assertPreserved(before, 'view:action');

  const search = page.getByRole('textbox', { name: 'Search lists and projects' }); await search.focus();
  before = await position(75, 90); await search.type('n');
  await assertPreserved(before, 'search');
});

test('clarifying and undoing a planned day update the canonical item and plan history atomically', { timeout: 60000 }, async t => {
  documents.length = 0; const server = await startServer({ browserUser: true }); t.after(server.close);
  await post(server.url, [createItem('capture')], undefined, 'disposable-test-user');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor(); await confirmed(page);
  await clickControl(page.locator('#clarifyInbox')); await page.locator('#clarifier').waitFor();
  await page.getByRole('button', { name: 'Action', exact: true }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.locator('[data-proposal="plannedDay"]').fill('2030-05-06');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitForBrowser(page, async () => {
    const { transact, projected } = await import('/inbox-store.js?v=9');
    return projected(await transact('disposable-test-user'))['item:capture']?.plannedDay === '2030-05-06';
  });
  await confirmed(page);
  const saved = (type, id = 'capture') => documents.find(document => document.UserID === 'disposable-test-user' && document.id === `record:${type}:${id}`)?.record;
  assert.equal(saved('item').plannedDay, '2030-05-06');
  let plan = saved('dailyPlan', 'personal_2030-05-06');
  assert.deepEqual(plan.actionIds, ['capture']); assert.equal(plan.revisionCount, 1);
  assert.equal(saved('dailyPlanRevision', plan.revisionHead).after.actionIds[0], 'capture');

  await page.getByRole('button', { name: 'Undo previous decision', exact: true }).click();
  await waitForBrowser(page, async () => {
    const { transact, projected } = await import('/inbox-store.js?v=9');
    return projected(await transact('disposable-test-user'))['item:capture']?.plannedDay === null;
  });
  await confirmed(page);
  assert.equal(saved('item').plannedDay, null);
  plan = saved('dailyPlan', 'personal_2030-05-06');
  assert.deepEqual(plan.actionIds, []); assert.equal(plan.revisionCount, 2);
  assert.deepEqual(saved('dailyPlanRevision', plan.revisionHead).before.actionIds, ['capture']);
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
  await page.getByRole('button', { name: 'No parent', exact: true }).click();
  await page.getByRole('button', { name: 'Make shopping list', exact: true }).click();
  await waitForBrowser(page, async () => {
    const { transact, projected } = await import('/inbox-store.js?v=9');
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
  assert.equal(await page.getByRole('textbox', { name: 'Item title' }).inputValue(), 'Dad');
  await page.locator('#clarifySkip').click();
  await page.waitForFunction(() => document.querySelector('#clarifyTitle').value === 'Call electrician');
  await page.getByRole('button', { name: 'Action', exact: true }).click();
  await page.getByRole('button', { name: 'Use Family as parent' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyHeading').textContent === 'All inbox items viewed'); await confirmed(page);
  const second = documents.find(doc => doc.UserID === 'disposable-test-user' && doc.id === 'record:item:second').record;
  assert.deepEqual(second.collectionRefs, [{ type: 'list', id: 'family' }]); assert.equal(second.listId, 'family');
  await page.getByRole('button', { name: 'Return to first unprocessed item', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyTitle').value === 'Dad');
  assert.equal(await page.locator('#clarifyProgress').textContent(), '1 of 1');
  await page.getByRole('button', { name: 'Reference', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#clarifyHeading').textContent === 'Clarify inbox complete'); await confirmed(page);
  assert.equal(documents.find(doc => doc.UserID === 'disposable-test-user' && doc.id === 'record:item:capture').record.status, 'reference');
});
