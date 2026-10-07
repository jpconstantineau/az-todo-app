import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inPlanningFocus, localMonday, membershipPaths, resolvePlanningFocus } from '../../html/plan.js';
import { clickControl, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { currentCreate } from './current-record.mjs';
import { documents, startServer } from './harness.mjs';

const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=7')).transact('alice'));
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

test('plan helpers use local Mondays, every membership path and a live-parent fallback', () => {
  assert.equal(localMonday(new Date(2026, 9, 11, 23, 30)), '2026-10-05');
  const records = {
    'list:role': { type: 'list', id: 'role', title: 'Role' },
    'list:initiative': { type: 'list', id: 'initiative', title: 'Initiative', parentRef: { type: 'list', id: 'role' } },
    'project:project': { type: 'project', id: 'project', title: 'Project', parentRef: { type: 'list', id: 'initiative' }, deleted: true },
  };
  const item = { collectionRefs: [{ type: 'project', id: 'project' }, { type: 'list', id: 'initiative' }] };
  assert.deepEqual(membershipPaths(item, records), ['Role / Initiative / Project', 'Role / Initiative']);
  assert.equal(inPlanningFocus(item, 'list:role', records), true);
  assert.equal(resolvePlanningFocus('project:project', records), 'list:initiative');
});

test('Plan routes through hierarchy, weekly offline intent and the existing day view without cloning actions', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url + '/#plan'); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  const week = await page.locator('#planWeek').inputValue();
  assert.match(week, /^\d{4}-\d{2}-\d{2}$/);
  const mutations = [
    currentCreate('list', 'role', { title: 'Parent', kind: 'role', description: 'Family and home' }),
    currentCreate('list', 'initiative', { title: 'Initiative', kind: 'initiative', parentRef: { type: 'list', id: 'role' } }),
    currentCreate('project', 'project', { title: 'Project', outcome: 'A finished result', parentRef: { type: 'list', id: 'initiative' } }),
    currentCreate('list', 'secondary', { title: 'Secondary', parentRef: { type: 'list', id: 'role' } }),
    currentCreate('item', 'nested', { title: 'Nested next', status: 'next', collectionRefs: [{ type: 'project', id: 'project' }] }),
    currentCreate('item', 'multiple', { title: 'Multiple paths', status: 'next', collectionRefs: [{ type: 'project', id: 'project' }, { type: 'list', id: 'secondary' }] }),
    currentCreate('item', 'unfiled', { title: 'Unfiled next', status: 'next' }),
    currentCreate('item', 'attention', { title: 'Waiting selected', status: 'waiting', waitingOn: 'Alex', plannedWeek: week, collectionRefs: [{ type: 'project', id: 'project' }] }),
    currentCreate('item', 'day', { title: 'Day only', status: 'next', plannedDay: '2030-05-06', collectionRefs: [{ type: 'list', id: 'secondary' }] }),
  ];
  const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: 'plan-fixture', mutations }) });
  assert.equal(response.status, 200, await response.text());
  await clickControl(page.locator('#sync')); await page.locator('#planFocus option[value="project:project"]').waitFor({ state: 'attached' }); await confirmed(page);

  assert.equal(await page.title(), 'Plan · Personal');
  assert.equal(await page.locator('#openPlan').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#planHeading').textContent(), 'Plan');
  await showView(page, 'capture'); await showView(page, 'plan');
  assert.ok(await page.locator('#planHeading').evaluate(element => element === document.activeElement));
  await page.goBack(); await page.waitForFunction(() => document.querySelector('#quickFocus').getAttribute('aria-current') === 'page');
  await page.goForward(); await page.waitForFunction(() => document.querySelector('#openPlan').getAttribute('aria-current') === 'page');

  await page.locator('#planFocusPicker > summary').click();
  await page.locator('#planFocus').selectOption('project:project');
  assert.deepEqual(await page.locator('#planBreadcrumbs button').allTextContents(), ['Workspace', 'Parent', 'Initiative', 'Project']);
  assert.equal(await page.locator('#planFocusKind').textContent(), 'Project');
  assert.equal(await page.locator('#planFocusDescription').textContent(), 'A finished result');
  assert.match(await page.locator('#planFocusCounts').textContent(), /2 Next actions/);
  assert.deepEqual((await page.locator('#planWeekActions article').evaluateAll(rows => rows.map(row => row.dataset.id))).sort(), ['multiple', 'nested']);
  assert.match(await page.locator('#planWeekActions').innerText(), /Parent \/ Initiative \/ Project/);
  assert.match(await page.locator('#planWeekActions').innerText(), /Parent \/ Secondary/);
  assert.equal(await page.locator('#planAttentionActions article').getAttribute('data-id'), 'attention');

  await context.setOffline(true);
  await page.getByRole('checkbox', { name: 'Plan Nested next for this week', exact: true }).click();
  await waitForBrowser(page, async selectedWeek => {
    const local = await (await import('/inbox-store.js?v=7')).transact('alice');
    return local.queue.some(entry => entry.operation.mutations.some(mutation => mutation.id === 'nested' && mutation.fields?.plannedWeek === selectedWeek));
  }, week);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Remove Nested next from this week');
  const pending = (await local(page)).queue;
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].operation.mutations[0].fields, { plannedWeek: week });
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#planFocus').inputValue(), 'project:project');
  assert.equal(await page.getByRole('checkbox', { name: 'Remove Nested next from this week', exact: true }).isChecked(), true);
  assert.deepEqual((await local(page)).queue, pending);
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  const stored = documents.filter(document => document.record?.type === 'item').map(document => document.record);
  assert.equal(stored.length, 5);
  assert.equal(stored.find(record => record.id === 'nested').plannedWeek, week);
  assert.equal(stored.find(record => record.id === 'nested').status, 'next');

  await page.getByRole('checkbox', { name: 'Remove Waiting selected from this week', exact: true }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).records['item:attention']?.plannedWeek === null); await confirmed(page);
  assert.equal(documents.find(document => document.record?.id === 'attention').record.plannedWeek, null);
  await page.locator('#planBreadcrumbs').getByRole('button', { name: 'Plan the whole workspace', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'Plan Unfiled next for this week', exact: true }).count(), 1);

  await page.locator('#planDay').fill('2030-05-06');
  assert.deepEqual(await page.locator('#planDayActions article').evaluateAll(rows => rows.map(row => row.dataset.id)), ['day']);
  assert.doesNotMatch(await page.locator('#planDayActions').innerText(), /Nested next/);
  await page.locator('#planOpenDay').click();
  await page.waitForFunction(() => document.querySelector('#yourWork').getAttribute('aria-current') === 'page');
  assert.equal(await page.locator('#view').inputValue(), 'day');
  assert.equal(await page.locator('#day').inputValue(), '2030-05-06');
  assert.deepEqual(await page.locator('#items h3').allTextContents(), ['Day only']);

  await showView(page, 'plan');
  await page.locator('#planFocusPicker > summary').click(); await page.locator('#planFocus').selectOption('project:project');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).draft.navigation.plan.focus === 'project:project');
  await page.route('**/api/v1/operations', route => route.fulfill({ status: 400, json: { apiVersion: 1, error: 'invalid_request', message: 'Keep this planned week.' } }));
  await page.getByRole('checkbox', { name: 'Plan Multiple paths for this week', exact: true }).click();
  await page.locator('#failure').waitFor();
  assert.equal(await page.locator('#planFocus').inputValue(), 'project:project');
  assert.match(await page.locator('#comparison').textContent(), /Planned week: /);
  assert.equal(await page.getByRole('checkbox', { name: 'Remove Multiple paths from this week', exact: true }).isChecked(), true);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#planFocus').inputValue(), 'project:project');
  assert.match(await page.locator('#comparison').textContent(), /Planned week: /);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#discard').click(); await page.locator('#failure').waitFor({ state: 'hidden' });
  await page.unroute('**/api/v1/operations');
  await page.evaluate(async () => (await import('/inbox-store.js?v=7')).transact('alice', local => { local.records['project:project'].deleted = true; }));
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#planFocus').inputValue(), 'list:initiative');
  assert.equal(await page.locator('#planFocusTitle').textContent(), 'Initiative');
});

test('Plan preferences stay isolated by workspace and account while archived work remains inspectable', { timeout: 90000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({
    apiVersion: 1, accountId: 'alice', operationId: 'plan-workspaces', mutations: [
      { type: 'workspace', id: 'work', action: 'create', expectedVersion: 0, fields: { title: 'Work' } },
      currentCreate('list', 'personal-role', { title: 'Personal role', kind: 'role' }),
      currentCreate('list', 'work-role', { title: 'Work role', kind: 'role', workspaceId: 'work' }),
      currentCreate('item', 'work-next', { title: 'Work next', status: 'next', workspaceId: 'work', collectionRefs: [{ type: 'list', id: 'work-role' }] }),
    ]
  }) });
  assert.equal(response.status, 200, await response.text());
  await clickControl(page.locator('#sync')); await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).records['list:work-role']?.version === 1); await confirmed(page);
  await showView(page, 'plan'); await page.locator('#planFocusPicker > summary').click(); await page.locator('#planFocus').selectOption('list:personal-role');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).draft.navigation.plan.focus === 'list:personal-role');
  await page.locator('#workspaceSelect').selectOption('work');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).selectedWorkspace === 'work');
  assert.equal(await page.locator('#planFocus').inputValue(), '');
  assert.equal(await page.locator('#planFocus option[value="list:personal-role"]').count(), 0);
  await page.locator('#planFocus').selectOption('list:work-role');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).workspaceDrafts.work.navigation.plan.focus === 'list:work-role');
  await clickControl(page.locator('#manageWorkspaces')); await page.getByRole('button', { name: 'Archive workspace: Work', exact: true }).click();
  await page.getByRole('button', { name: 'Unarchive workspace: Work', exact: true }).waitFor(); await page.locator('#closeWorkspaces').click();
  assert.match(await page.locator('#planStatus').textContent(), /read-only/);
  assert.equal(await page.getByRole('checkbox', { name: 'Plan Work next for this week', exact: true }).isDisabled(), true);
  await page.locator('#workspaceSelect').selectOption('personal');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).selectedWorkspace === 'personal');
  assert.equal(await page.locator('#planFocus').inputValue(), 'list:personal-role');

  user = 'bob'; await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact(null)).accountId === 'bob'); await confirmed(page);
  await showView(page, 'plan');
  assert.equal(await page.locator('#planFocus').inputValue(), '');
  assert.equal(await page.locator('#planFocus option').count(), 1);
  assert.doesNotMatch(await page.locator('#plan').innerText(), /Personal role|Work role|Work next/);
});
