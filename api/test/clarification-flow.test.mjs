import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';
import { clickControl } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { flowProposal, newFlow, flowDecision, flowEdits } from '../../html/clarification-flow.js';
import { clarificationFields } from '../api/v1/clarification.mjs';
import { reviewReady } from '../../html/inbox-fields.js';
import { defaultSettings } from '../api/shared/defaults.mjs';

const create = (type, id, fields) => ({ type, id, action: 'create', expectedVersion: 0, fields });
const item = { id: 'capture', version: 1, title: 'Original capture', workspaceId: 'personal' };
function summary(kind, project = 'none', extra = {}) {
  let session = newFlow();
  const advance = p => { session = flowDecision(session, { ...flowProposal(), ...p }, 'accepted', item); assert.deepEqual(clarificationFields(session), session); };
  const actionable = !['someday', 'reference', 'trash'].includes(kind);
  advance({ choice: actionable ? 'yes' : 'no' });
  if (actionable) {
    advance({ text: 'Call the insurer' });
    advance({ choice: project, projectTitle: project === 'new' ? 'Insurance' : '', outcome: project === 'new' ? 'Coverage in place' : '', projectId: project === 'existing' ? 'existing' : '' });
    advance({ choice: kind === 'completed' ? 'yes' : 'no' });
  }
  advance({ choice: kind, ...extra });
  if (session.step === 'organize') advance({ ...session.proposal });
  return session;
}
function mutations(session, id = 'capture', version = 1) {
  const result = [create('clarification', id, { ...session, step: 'complete' })];
  if (session.answers.disposition.choice === 'trash') result.push({ type: 'item', id, action: 'delete', expectedVersion: version });
  else {
    const fields = flowEdits(session.answers);
    if (session.answers.project?.choice === 'new') { fields.projectId = 'new-project'; result.push(create('project', 'new-project', { title: 'Insurance', outcome: 'Coverage in place' })); }
    result.push({ type: 'item', id, action: 'update', expectedVersion: version, fields });
  }
  return result;
}
async function post(url, mutations, operationId = crypto.randomUUID(), accountId = 'alice') {
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: accountId, userRoles: ['authenticated'] })).toString('base64') }, body: JSON.stringify({ apiVersion: 1, accountId, operationId, mutations }) });
  return { status: response.status, body: await response.json() };
}
const stored = (type, id = 'capture') => documents.find(doc => doc.UserID === 'alice' && doc.id === `record:${type}:${id}`)?.record;

test('branch decisions require relevant answers, retain proposals, and back never mutates an item', () => {
  assert.throws(() => flowDecision(newFlow(), flowProposal(), 'accepted', item), /Choose Yes/);
  for (const kind of ['reference', 'trash', 'someday']) {
    const session = summary(kind);
    assert.deepEqual(Object.keys(session.answers), kind === 'trash' ? ['actionable', 'disposition'] : ['actionable', 'disposition', 'organize']);
    const back = flowDecision(session, session.proposal, 'back', item);
    assert.equal(back.step, kind === 'trash' ? 'disposition' : 'organize');
    if (kind !== 'trash') assert.equal(back.proposal.text, item.title);
    assert.equal(back.answers.organize, undefined);
  }
  assert.throws(() => summary('waiting'), /Waiting for/);
  assert.throws(() => summary('deferred'), /start date/);
  assert.throws(() => summary('planned'), /planned day/);
  const invalid = summary('completed'); invalid.answers.twoMinutes = 'no';
  assert.throws(() => clarificationFields(invalid), /valid clarification/);
  assert.throws(() => clarificationFields({ ...newFlow(), answers: { nextAction: 'Invented' } }), /branch/);
  assert.throws(() => summary('someday', 'none', { reviewDate: '2026-02-30' }), /calendar date/);
  for (const status of ['waiting', 'someday']) {
    assert.equal(reviewReady({ status, reviewDate: '2026-10-03' }, new Date(2026, 9, 3, 12)), true);
    assert.equal(reviewReady({ status }, new Date()), false);
    assert.equal(reviewReady({ status, reviewDate: '2099-01-01' }, new Date()), false);
  }
  assert.equal(reviewReady({ status: 'reference', reviewDate: '2020-01-01' }), false);
});

test('all v2 dispositions apply atomically, preserve source and dates, and replay exactly once', async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  assert.equal((await post(server.url, [create('settings', 'settings', { defaults: { ...defaultSettings, statuses: ['next'] } }), create('project', 'existing', { title: 'Existing', outcome: 'Existing outcome' })])).status, 200);
  const cases = [['reference'], ['someday'], ['someday', 'none', { reviewDate: '2026-10-05' }], ['trash'], ['next'], ['waiting', 'keep'], ['waiting', 'none', { waitingOn: 'Broker', reviewDate: '2026-10-06' }], ['deferred', 'none', { startDate: '2026-10-06' }], ['planned', 'existing', { plannedDay: '2026-10-07' }], ['completed', 'new'], ['dropped']];
  for (const [index, [kind, project = 'none', extra = {}]] of cases.entries()) {
    const id = `case-${index}`;
    const original = { title: item.title, description: 'Existing notes', originalText: 'Exact original source', projectId: 'existing', reviewDateUtc: '2026-10-04T10:00:00Z', dueDate: '2026-10-09' };
    assert.equal((await post(server.url, [create('item', id, original)])).status, 200);
    const session = summary(kind, project, { ...(kind === 'waiting' ? { waitingOn: 'Broker' } : {}), ...extra });
    const batch = mutations(session, id), operationId = crypto.randomUUID();
    const saved = await post(server.url, batch, operationId);
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.deepEqual(await post(server.url, batch, operationId), saved);
    const record = stored('item', id);
    assert.equal(record.originalText, original.originalText); assert.equal(record.description, original.description); assert.equal(record.dueDate, original.dueDate);
    assert.equal(record.deleted, kind === 'trash');
    if (kind === 'someday') { assert.equal(record.reviewDate, extra.reviewDate || null); assert.equal(record.reviewDateUtc, null); }
    if (kind === 'waiting' && !extra.reviewDate) assert.equal(record.reviewDateUtc, original.reviewDateUtc);
    if (project === 'new') assert.equal(stored('project', 'new-project').outcome, 'Coverage in place');
  }
});

test('v2 rejects partial, forged, stale, foreign and deleted decisions without orphan projects', async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  await post(server.url, [create('item', 'capture', { title: item.title })]);
  const session = summary('next', 'new'), batch = mutations(session);
  assert.equal((await post(server.url, [batch[0]])).status, 400);
  const wrong = structuredClone(batch); wrong.at(-1).fields.status = 'completed';
  assert.equal((await post(server.url, wrong)).status, 400);
  assert.equal(stored('project', 'new-project'), undefined);
  faults.batchIndex = 2;
  assert.equal((await post(server.url, batch)).status, 503);
  assert.equal(stored('clarification'), undefined); assert.equal(stored('project', 'new-project'), undefined);
  await post(server.url, [create('workspace', 'work', { title: 'Work' }), create('list', 'other-space', { title: 'Work only', workspaceId: 'work' })]);
  const foreign = summary('reference'); foreign.answers.organize.listId = 'other-space';
  assert.equal((await post(server.url, mutations(foreign))).status, 400);
  assert.notEqual((await post(server.url, batch, crypto.randomUUID(), 'bob')).status, 200);
  await post(server.url, [{ type: 'item', id: 'capture', action: 'update', expectedVersion: 1, fields: { title: 'Other device' } }]);
  assert.equal((await post(server.url, batch)).body.status, 'conflict');
  assert.equal(stored('project', 'new-project'), undefined);
  await post(server.url, [{ type: 'item', id: 'capture', action: 'delete', expectedVersion: 2 }]);
  assert.equal((await post(server.url, mutations(session, 'capture', 3))).body.status, 'conflict');
  assert.equal(stored('project', 'new-project'), undefined);
});

test('v2 lost acknowledgement replays one final decision, and flow versions cannot be reinterpreted', async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  await post(server.url, [create('item', 'capture', { title: item.title })]);
  const batch = mutations(summary('next', 'new')), operationId = crypto.randomUUID();
  faults.loseBatchResponse = true;
  assert.equal((await post(server.url, batch, operationId)).status, 503);
  const result = await post(server.url, batch, operationId);
  assert.equal(result.status, 200); assert.equal(stored('item').version, 2);
  assert.equal(stored('project', 'new-project').version, 1);
  const legacy = { step: 0, answers: {}, proposal: { text: '', status: '', waitingOn: '', reviewDate: '', startDate: '' } };
  assert.equal((await post(server.url, [{ type: 'clarification', id: 'capture', action: 'update', expectedVersion: 1, fields: legacy }])).status, 400);
});

const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const local = page => page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
async function setup(t) {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  await post(server.url, [create('item', 'capture', { title: item.title, originalText: 'Untouched source' })]);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await clickControl(page.getByRole('button', { name: 'Clarify Original capture', exact: true, includeHidden: true }));
  if (process.env.CLARIFICATION_SCREENSHOTS) {
    await mkdir(process.env.CLARIFICATION_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.CLARIFICATION_SCREENSHOTS}/gtd-start-390.png` });
  }
  return { page, context, url: server.url, setUser: value => { user = value; } };
}
async function next(page, step) {
  await page.locator('#clarifyAccept').click();
  await waitForBrowser(page, async step => (await (await import('/inbox-store.js')).transact('alice')).draft.clarification?.session.step === step, step);
}

test('v2 reference skips action questions, journals offline, reloads, applies and stays out of Inbox', { timeout: 60000 }, async t => {
  const { page, context } = await setup(t); await context.setOffline(true);
  await page.locator('[name=flow_choice][value=no]').check(); await next(page, 'disposition');
  await page.locator('[name=flow_choice]').selectOption('reference'); await next(page, 'organize');
  assert.equal(await page.locator('[name=flow_text]').inputValue(), item.title);
  await page.locator('[name=flow_notes]').fill('A reference, not a commitment');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.clarification?.proposal.notes === 'A reference, not a commitment');
  await page.locator('#clarifyStop').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.clarification?.open === false);
  await page.reload(); await page.locator('#workspace').waitFor(); assert.equal(await page.locator('#clarifier').isVisible(), false);
  await clickControl(page.getByRole('button', { name: 'Clarify Original capture', exact: true, includeHidden: true }));
  assert.equal(await page.locator('[name=flow_notes]').inputValue(), 'A reference, not a commitment');
  await next(page, 'summary');
  assert.equal((await local(page)).queue.every(entry => entry.operation.mutations.every(m => m.type === 'clarification')), true);
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert.ok(await page.locator('#clarifier').evaluate(el => el.scrollWidth <= el.clientWidth));
    if (process.env.CLARIFICATION_SCREENSHOTS) { await mkdir(process.env.CLARIFICATION_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: `${process.env.CLARIFICATION_SCREENSHOTS}/gtd-reference-${theme}-${width}.png` }); }
  }
  await next(page, 'complete'); await page.locator('#clarifyStop').click();
  assert.equal(await page.getByRole('button', { name: 'Edit Original capture', exact: true }).count(), 0);
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(stored('item').status, 'reference'); assert.equal(stored('item').originalText, 'Untouched source');
  assert.equal(stored('clarification').answers.nextAction, undefined);
});

test('v2 creates a project only at Apply, handles Back, and explicitly confirms two-minute work', { timeout: 60000 }, async t => {
  const { page, context } = await setup(t); await context.setOffline(true);
  await page.locator('[name=flow_choice][value=yes]').check(); await next(page, 'nextAction');
  await page.locator('[name=flow_text]').fill('Call the insurer'); await next(page, 'project');
  await page.locator('[name=flow_choice]').selectOption('new');
  await page.locator('[name=flow_projectTitle]').fill('Insurance'); await page.locator('[name=flow_outcome]').fill('Coverage in place'); await next(page, 'twoMinutes');
  await page.locator('[name=flow_choice][value=yes]').check(); await next(page, 'disposition');
  assert.equal(stored('item').status, 'inbox');
  await page.locator('[name=flow_choice]').selectOption('completed'); await next(page, 'organize');
  await next(page, 'summary');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#clarifyBack').click();
  await page.locator('[name=flow_text]').waitFor(); await page.locator('[name=flow_text]').fill('Called the insurer'); await next(page, 'summary');
  assert.equal((await local(page)).queue.every(entry => entry.operation.mutations.every(m => m.type === 'clarification')), true);
  await next(page, 'complete');
  const pending = (await local(page)).queue.at(-1).operation; assert.equal(pending.mutations.length, 3);
  await page.locator('#clarifyStop').click(); await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(stored('item').title, 'Called the insurer'); assert.equal(stored('item').status, 'completed');
  assert.ok(stored('item').projectId); assert.equal(stored('project', stored('item').projectId).outcome, 'Coverage in place');
});

test('v2 stopped decisions retain private drafts on failure and clear on workspace/account switches', { timeout: 60000 }, async t => {
  const { page, context, url, setUser } = await setup(t);
  await post(url, [create('workspace', 'work', { title: 'Work' })]);
  await page.locator('#clarifyStop').click(); await clickControl(page.locator('#sync')); await confirmed(page);
  await clickControl(page.getByRole('button', { name: 'Clarify Original capture', exact: true, includeHidden: true }));
  await page.locator('[name=flow_choice][value=yes]').check(); await next(page, 'nextAction');
  await page.locator('[name=flow_text]').fill('Private proposed wording');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.clarification?.proposal.text === 'Private proposed wording');
  await page.locator('#clarifyStop').click();
  await page.locator('#workspaceSelect').selectOption('work');
  await page.waitForFunction(() => !document.querySelector('#clarifyFlow').textContent);
  await page.locator('#workspaceSelect').selectOption('personal');
  await clickControl(page.getByRole('button', { name: 'Clarify Original capture', exact: true, includeHidden: true }));
  assert.equal(await page.locator('[name=flow_text]').inputValue(), 'Private proposed wording');
  await confirmed(page); await context.setOffline(true);
  await page.evaluate(() => { window.originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.locator('#clarifyAccept').click(); await page.locator('#recovery').waitFor();
  assert.match(await page.locator('#recoveryText').inputValue(), /Private proposed wording/);
  assert.equal((await local(page)).queue.length, 0);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  setUser('bob'); await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(await page.locator('#clarifyFlow').textContent(), '');
  assert.equal(await page.locator('#clarifyOriginal').textContent(), '');
  assert.equal(await page.locator('#recoveryText').inputValue(), '');
});

for (const kind of ['someday', 'waiting', 'planned', 'deferred', 'trash']) test(`v2 browser applies ${kind} with relevant controls`, { timeout: 60000 }, async t => {
  const { page } = await setup(t), actionable = !['someday', 'trash'].includes(kind);
  await page.locator(`[name=flow_choice][value=${actionable ? 'yes' : 'no'}]`).check(); await next(page, actionable ? 'nextAction' : 'disposition');
  if (actionable) {
    await page.locator('[name=flow_text]').fill('Call insurer'); await next(page, 'project');
    await page.locator('[name=flow_choice]').selectOption('none'); await next(page, 'twoMinutes');
    await page.locator('[name=flow_choice][value=no]').check(); await next(page, 'disposition');
    assert.equal(await page.locator('[name=flow_choice] option[value=completed]').count(), 0);
  }
  await page.locator('[name=flow_choice]').selectOption(kind);
  if (kind === 'waiting') await page.locator('[name=flow_waitingOn]').fill('Broker');
  if (kind === 'someday') await page.locator('[name=flow_reviewDate]').fill('2026-10-05');
  if (kind === 'planned') await page.locator('[name=flow_plannedDay]').fill('2026-10-06');
  if (kind === 'deferred') await page.locator('[name=flow_startDate]').fill('2026-10-07');
  await next(page, kind === 'trash' ? 'summary' : 'organize');
  if (kind !== 'trash') await next(page, 'summary');
  await next(page, 'complete'); await page.locator('#clarifyStop').click(); await confirmed(page);
  assert.equal(stored('item').deleted, kind === 'trash');
  if (kind !== 'trash') assert.equal(stored('item').status, kind === 'planned' ? 'next' : kind);
  else {
    assert.equal((await post((new URL(page.url())).origin, [{ type: 'item', id: 'capture', action: 'restore', expectedVersion: 2 }])).status, 200);
    assert.equal(stored('item').originalText, 'Untouched source');
  }
});
