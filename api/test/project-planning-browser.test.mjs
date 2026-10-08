import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { clickControl, showView } from './navigation-helper.mjs';

const mutation = (type, id, expectedVersion, fields, action = expectedVersion ? 'update' : 'create') => ({ type, id, expectedVersion, action, ...(fields ? { fields: {
  ...(action === 'create' && type === 'project' ? { workspaceId: 'personal', status: 'active' } : {}), ...fields
} } : {}) });
async function post(url, mutations, operationId = crypto.randomUUID()) {
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json',
    'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: 'alice', userRoles: ['authenticated'] })).toString('base64') },
  body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId, mutations }) });
  return { status: response.status, body: await response.json() };
}
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=15')).transact('alice'));

test('project planner resumes offline, accepts selected actions, and recovers exact content after conflict', { timeout: 120000 }, async t => {
  documents.length = 0; let browserUser = 'alice'; const server = await startServer({ browserUser: () => browserUser }); t.after(server.close);
  assert.equal((await post(server.url, [mutation('project', 'launch', 0, { title: 'Launch', outcome: 'Customers can use it' })])).status, 200);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '/#work');
  try { await page.locator('#workspace').waitFor({ timeout: 10000 }); }
  catch { assert.fail(`workspace did not open: ${errors.join(' | ')}; error=${await page.locator('#error').textContent()}; login=${await page.locator('#loginStatus').textContent()}`); }
  await confirmed(page);
  assert.equal(await page.locator('#projectPlanner').isVisible(), false, 'planning stays optional and never opens with ordinary project creation/navigation');
  await page.locator('#view').selectOption('project:launch');
  const opener = page.getByRole('button', { name: /^Plan project / });
  await clickControl(opener);
  assert.ok(await page.locator('#projectPlanner').isVisible());
  await page.locator('[name=purposePrinciples]').fill('Help customers finish a first run');
  await page.locator('[name=desiredEvidence]').fill('A customer completes setup');
  await page.locator('[name=organizationApproach]').fill('Learn, then publish');
  await page.locator('[name=unresolvedQuestions]').fill('Which step is unclear?');
  for (const [title, kind] of [['Consider a video', 'brainstorm'], ['Publish the guide', 'action'], ['Interview pilot users', 'learning']]) {
    await page.locator('#addProjectPlanCandidate').click();
    const row = page.locator('.project-plan-candidate').last();
    await row.locator('input').fill(title); await row.locator('select').selectOption(kind);
  }
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=15')).transact('alice');
    return state.draft.projectPlanning?.sections.purposePrinciples === 'Help customers finish a first run' && state.draft.projectPlanning.candidates.length === 3;
  });
  await context.setOffline(true); await page.reload(); await page.locator('#projectPlanner').waitFor();
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), 'Help customers finish a first run');
  assert.deepEqual(await page.locator('.project-plan-candidate input').evaluateAll(inputs => inputs.map(input => input.value)), ['Consider a video', 'Publish the guide', 'Interview pilot users']);
  await page.locator('#acceptProjectPlan').click();
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=15')).transact('alice'), entry = state.queue[0];
    return state.draft.projectPlanning === null && entry?.operation.mutations.filter(mutation => mutation.type === 'item').length === 2 &&
      entry.operation.mutations.some(mutation => mutation.type === 'projectPlanRevision');
  });
  const pending = await local(page), operation = pending.queue[0].operation;
  assert.equal(operation.mutations.length, 4);
  for (const item of operation.mutations.filter(entry => entry.type === 'item')) {
    assert.equal(item.fields.status, 'next'); assert.equal(item.fields.projectId, 'launch');
    for (const field of ['dueDate', 'startDate', 'reviewDate', 'plannedDay', 'timeRequired']) assert.equal(field in item.fields, false);
  }
  await context.setOffline(false); await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=15')).transact('alice');
    return state.queue.length === 0 && Object.values(state.records).filter(record => record.type === 'projectPlanRevision').length === 1;
  });
  await confirmed(page);
  assert.equal(documents.filter(row => row.UserID === 'alice' && row.record?.type === 'item' && row.record.projectId === 'launch').length, 2);

  await page.locator('#view').selectOption('project:launch', { force: true }); await clickControl(opener);
  await page.locator('#closeProjectPlanning').click();
  await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Plan project Launch');
  await page.setViewportSize({ width: 320, height: 844 }); await clickControl(opener);
  assert.ok(await page.locator('#projectPlanner').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));

  await context.setOffline(true);
  await page.locator('[name=purposePrinciples]').fill('Exact conflicted purpose');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning?.sections.purposePrinciples === 'Exact conflicted purpose');
  await page.locator('#acceptProjectPlan').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).queue.length === 1);
  assert.equal((await post(server.url, [mutation('project', 'launch', 2, { title: 'Launch updated elsewhere' })])).status, 200);
  await context.setOffline(false); await clickControl(page.locator('#sync'));
  await page.locator('#failure').waitFor();
  assert.ok(await page.locator('#recoverProjectPlan').isVisible());
  assert.match(await page.locator('#comparison').textContent(), /Exact conflicted purpose/);
  await page.locator('#recoverProjectPlan').click(); await page.locator('#projectPlanner').waitFor();
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), 'Exact conflicted purpose');
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=15')).transact('alice');
    return state.queue.length === 0 && state.draft.projectPlanning?.sourceVersion === 3 && state.draft.projectPlanning.sections.purposePrinciples === 'Exact conflicted purpose';
  });
  assert.equal((await post(server.url, [mutation('workspace', 'work', 0, { title: 'Work' })])).status, 200);
  await page.locator('#closeProjectPlanning').click(); await clickControl(page.locator('#sync'));
  await page.waitForFunction(() => document.querySelector('#workspaceSelect option[value="work"]'));
  await page.locator('#workspaceSelect').selectOption('work');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).selectedWorkspace === 'work');
  assert.equal(await page.locator('#projectPlanner').isVisible(), false);
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), '', 'another workspace cannot expose the personal planning draft');
  await page.locator('#workspaceSelect').selectOption('personal');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).selectedWorkspace === 'personal');
  await page.locator('#view').selectOption('project:launch'); await clickControl(opener);
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), 'Exact conflicted purpose');
  await page.locator('#closeProjectPlanning').click();
  browserUser = 'bob'; await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact(null)).accountId === 'bob');
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), '', 'another account cannot expose the planning draft');
  browserUser = 'alice'; await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact(null)).accountId === 'alice' && !document.querySelector('#workspace').hidden);
  await showView(page, 'work');
  await page.locator('#view').selectOption('project:launch', { force: true }); await clickControl(opener);
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), 'Exact conflicted purpose');
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.locator('#acceptProjectPlan').click(); await page.locator('#recovery').waitFor();
  assert.match(await page.locator('#recoveryText').inputValue(), /Exact conflicted purpose/);
  assert.equal((await local(page)).queue.length, 0, 'a failed journal cannot queue a partial plan acceptance');
  assert.deepEqual(errors, []);
});
