import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { estimateSummary, inPlanningFocus, localMonday, membershipPaths, orderedDayItems, resolvePlanningFocus } from '../../html/plan.js';
import { clickControl, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { currentCreate } from './current-record.mjs';
import { documents, startServer } from './harness.mjs';

const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=9')).transact('alice'));
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
  const dayRecords = {
    'dailyPlan:personal_2026-10-07': { actionIds: ['two'] },
    'item:one': { type: 'item', id: 'one', workspaceId: 'personal', plannedDay: '2026-10-07', createdUtc: '2026-01-01', effortEstimate: { scale: 'tshirt', value: 'M' } },
    'item:two': { type: 'item', id: 'two', workspaceId: 'personal', plannedDay: '2026-10-07', createdUtc: '2026-01-02', effortEstimate: { scale: 'fibonacci', value: 8 } },
    'item:three': { type: 'item', id: 'three', workspaceId: 'personal', plannedDay: '2026-10-07', createdUtc: '2026-01-03' }
  };
  const ordered = orderedDayItems(dayRecords, 'personal', '2026-10-07');
  assert.deepEqual(ordered.map(entry => entry.id), ['two', 'one', 'three'], 'legacy members follow saved IDs in stable order');
  assert.equal(estimateSummary(ordered, 'tshirt'), '1 M · 1 unestimated · 1 previous-scale');
  assert.equal(estimateSummary(ordered, 'fibonacci'), '8 points · 1 unestimated · 1 previous-scale');
  assert.equal(estimateSummary(ordered, 'none'), '');
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
    currentCreate('item', 'direct', { title: 'Direct role action', status: 'next', plannedWeek: week, collectionRefs: [{ type: 'list', id: 'role' }] }),
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
  await page.locator('#planFocus').selectOption('list:role');
  assert.match(await page.locator('#planFocusCounts').textContent(), /1 of 1 active project has a Next action/);
  assert.match(await page.locator('#planBalance').textContent(), /Direct: 1/);
  await page.locator('#planFocus').selectOption('project:project');
  assert.deepEqual(await page.locator('#planBreadcrumbs button').allTextContents(), ['Workspace', 'Parent', 'Initiative', 'Project']);
  assert.equal(await page.locator('#planFocusKind').textContent(), 'Project');
  assert.equal(await page.locator('#planFocusDescription').textContent(), 'A finished result');
  assert.match(await page.locator('#planFocusCounts').textContent(), /2 Next actions/);
  assert.equal(await page.locator('#planHierarchy button[aria-label="Plan Project"]').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Edit Project', exact: true }).click();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  assert.ok(await page.getByRole('button', { name: 'Edit Project', exact: true }).evaluate(element => element === document.activeElement));
  assert.deepEqual((await page.locator('#planWeekActions article').evaluateAll(rows => rows.map(row => row.dataset.id))).sort(), ['multiple', 'nested']);
  assert.match(await page.locator('#planWeekActions').innerText(), /Parent \/ Initiative \/ Project/);
  assert.match(await page.locator('#planWeekActions').innerText(), /Parent \/ Secondary/);
  assert.equal(await page.locator('#planAttentionActions article').getAttribute('data-id'), 'attention');

  await context.setOffline(true);
  await page.getByRole('checkbox', { name: 'Plan Nested next for this week', exact: true }).click();
  await waitForBrowser(page, async selectedWeek => {
    const local = await (await import('/inbox-store.js?v=9')).transact('alice');
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
  assert.equal(stored.length, 6);
  assert.equal(stored.find(record => record.id === 'nested').plannedWeek, week);
  assert.equal(stored.find(record => record.id === 'nested').status, 'next');

  await page.locator('#planAttention > summary').click();
  await page.getByRole('checkbox', { name: 'Remove Waiting selected from this week', exact: true }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).records['item:attention']?.plannedWeek === null); await confirmed(page);
  assert.equal(documents.find(document => document.record?.id === 'attention').record.plannedWeek, null);
  await page.locator('#planBreadcrumbs').getByRole('button', { name: 'Plan the whole workspace', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: 'Plan Unfiled next for this week', exact: true }).count(), 1);

  await page.locator('#planDay').fill('2030-05-06');
  assert.deepEqual(await page.locator('#planDayActions > li[data-id]').evaluateAll(rows => rows.map(row => row.dataset.id)), ['day']);
  assert.doesNotMatch(await page.locator('#planDayActions').innerText(), /Nested next/);
  await page.locator('#planOpenDay').click();
  await page.waitForFunction(() => document.querySelector('#yourWork').getAttribute('aria-current') === 'page');
  assert.equal(await page.locator('#view').inputValue(), 'day');
  assert.equal(await page.locator('#day').inputValue(), '2030-05-06');
  assert.deepEqual(await page.locator('#items h3').allTextContents(), ['Day only']);

  await showView(page, 'plan');
  await page.locator('#planFocusPicker > summary').click(); await page.locator('#planFocus').selectOption('project:project');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.navigation.plan.focus === 'project:project');
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
  await page.evaluate(async () => (await import('/inbox-store.js?v=9')).transact('alice', local => { local.records['project:project'].deleted = true; }));
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
  await clickControl(page.locator('#sync')); await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).records['list:work-role']?.version === 1); await confirmed(page);
  await showView(page, 'plan'); await page.locator('#planFocusPicker > summary').click(); await page.locator('#planFocus').selectOption('list:personal-role');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.navigation.plan.focus === 'list:personal-role');
  await page.locator('#workspaceSelect').selectOption('work');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).selectedWorkspace === 'work');
  assert.equal(await page.locator('#planFocus').inputValue(), '');
  assert.equal(await page.locator('#planFocus option[value="list:personal-role"]').count(), 0);
  await page.locator('#planFocus').selectOption('list:work-role');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).workspaceDrafts.work.navigation.plan.focus === 'list:work-role');
  await clickControl(page.locator('#manageWorkspaces')); await page.getByRole('button', { name: 'Archive workspace: Work', exact: true }).click();
  await page.getByRole('button', { name: 'Unarchive workspace: Work', exact: true }).waitFor(); await page.locator('#closeWorkspaces').click();
  await showView(page, 'plan');
  assert.match(await page.locator('#planStatus').textContent(), /read-only/);
  assert.equal(await page.getByRole('checkbox', { name: 'Plan Work next for this week', exact: true }).isDisabled(), true);
  await page.locator('#workspaceSelect').selectOption('personal');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).selectedWorkspace === 'personal');
  assert.equal(await page.locator('#planFocus').inputValue(), 'list:personal-role');

  user = 'bob'; await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact(null)).accountId === 'bob'); await confirmed(page);
  await showView(page, 'plan');
  assert.equal(await page.locator('#planFocus').inputValue(), '');
  assert.equal(await page.locator('#planFocus option').count(), 1);
  assert.doesNotMatch(await page.locator('#plan').innerText(), /Personal role|Work role|Work next/);
});

test('Day builds an ordered offline plan with relative estimates, assessment history and title-only add', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url + '/#plan'); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.locator('#planDay').fill('2030-05-06');
  assert.equal(await page.locator('#planEstimationMethod').inputValue(), 'none');
  await page.locator('#planQuickAdd input[name="title"]').fill('First day action');
  await page.locator('#planQuickAdd').getByRole('button', { name: 'Add to this day' }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=9')).transact('alice');
    return Object.values(local.records).some(record => record.type === 'dailyPlan' && record.planDay === '2030-05-06') ||
      local.queue.some(entry => entry.operation.mutations.some(mutation => mutation.type === 'dailyPlan' && mutation.fields.planDay === '2030-05-06'));
  });
  await page.locator('#planQuickAdd input[name="title"]').waitFor();
  await page.waitForFunction(() => document.querySelector('#planQuickAdd input[name="title"]').value === '' && document.querySelectorAll('#planDayActions > li[data-id]').length === 1);
  await page.locator('#planQuickAdd input[name="title"]').fill('Second day action');
  await page.locator('#planQuickAdd').getByRole('button', { name: 'Add to this day' }).click();
  await waitForBrowser(page, async () => {
    const local = await (await import('/inbox-store.js?v=9')).transact('alice');
    return Object.values((await import('/inbox-store.js?v=9')).projected(local)).some(record => record.title === 'Second day action');
  });
  await confirmed(page);
  assert.deepEqual(await page.locator('#planDayActions > li[data-id] .day-plan-content > button').allTextContents(), ['First day action', 'Second day action']);
  assert.match(await page.locator('#planDayActions').innerText(), /No permanent priority/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  const selectEstimationMethod = async (method, summary) => {
    await page.locator('#planEstimationMethod').selectOption(method);
    await waitForBrowser(page, async expected => {
      const { projected, transact } = await import('/inbox-store.js?v=9');
      return projected(await transact('alice'))['planPreference:personal']?.estimationMethod === expected;
    }, method);
    await page.waitForFunction(expected => document.querySelector('#planLoadSummary').textContent === expected, summary);
    await confirmed(page);
  };
  await selectEstimationMethod('tshirt', 'Needs assessment · No current-scale estimates · 2 unestimated · 0 previous-scale');
  await page.getByLabel('Estimate First day action using T-shirt').selectOption('L');
  await waitForBrowser(page, async () => {
    const { projected, transact } = await import('/inbox-store.js?v=9');
    const records = Object.values(projected(await transact('alice')));
    return records.find(record => record.title === 'First day action')?.effortEstimate?.value === 'L';
  });
  await confirmed(page);
  assert.match(await page.locator('#planLoadSummary').textContent(), /1 L · 1 unestimated · 0 previous-scale/);
  await page.locator('#planLoadAssessment').selectOption('full');
  await waitForBrowser(page, async () => {
    const { projected, transact } = await import('/inbox-store.js?v=9');
    return Object.values(projected(await transact('alice'))).find(record => record.type === 'dailyPlan' && record.planDay === '2030-05-06')?.loadAssessment === 'full';
  });
  await confirmed(page);
  await page.getByLabel('Estimate Second day action using T-shirt').selectOption('M');
  await waitForBrowser(page, async () => {
    const { projected, transact } = await import('/inbox-store.js?v=9');
    const records = Object.values(projected(await transact('alice')));
    return records.find(record => record.title === 'Second day action')?.effortEstimate?.value === 'M' &&
      records.find(record => record.type === 'dailyPlan' && record.planDay === '2030-05-06')?.loadAssessment === 'needs_reassessment';
  });
  await confirmed(page);
  assert.equal(await page.locator('#planLoadAssessment').inputValue(), 'needs_reassessment');
  await page.locator('#planHistory').getByText('Plan history').click();
  assert.match(await page.locator('#planHistoryEntries').innerText(), /Full → Needs reassessment/);
  await selectEstimationMethod('fibonacci', 'Needs reassessment · 0 points · 0 unestimated · 2 previous-scale');
  assert.match(await page.locator('#planLoadSummary').textContent(), /0 points · 0 unestimated · 2 previous-scale/);
  await selectEstimationMethod('none', 'Needs reassessment');
  assert.equal(await page.locator('#planLoadSummary').textContent(), 'Needs reassessment');
  assert.match(await page.locator('#planDayActions').innerText(), /L \(tshirt, previous scale\)/);
  assert.match(await page.locator('#planDayActions').innerText(), /M \(tshirt, previous scale\)/);

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Move Second day action up from position 2' }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).queue.length > 0);
  assert.deepEqual(await page.locator('#planDayActions > li[data-id] .day-plan-content > button').allTextContents(), ['Second day action', 'First day action']);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#planDay').inputValue(), '2030-05-06');
  assert.deepEqual(await page.locator('#planDayActions > li[data-id] .day-plan-content > button').allTextContents(), ['Second day action', 'First day action']);
  assert.match(await page.locator('#planStatus').textContent(), /Working offline/);
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);

  const items = documents.filter(document => document.record?.type === 'item').map(document => document.record);
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.plannedDay === '2030-05-06' && item.priority === null && item.timeRequired === null));
  const plan = documents.find(document => document.record?.type === 'dailyPlan')?.record;
  assert.deepEqual(plan.actionIds, items.sort((a, b) => a.title.localeCompare(b.title)).reverse().map(item => item.id));
  assert.ok(documents.filter(document => document.record?.type === 'dailyPlanRevision').length >= 5);

  const carryover = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: 'carryover-fixture', mutations: [
      currentCreate('item', 'carryover-keep', { title: 'Keep on prior date', status: 'waiting', waitingOn: 'Alex', plannedDay: '2030-05-05', dueDate: '2030-05-20' }),
      currentCreate('item', 'carryover-move', { title: 'Keep identity', status: 'waiting', waitingOn: 'Alex', plannedDay: '2030-05-05', dueDate: '2030-05-20', priority: 'high', timeRequired: '45m' }),
      currentCreate('item', 'carryover-remove', { title: 'Remove only membership', status: 'next', plannedDay: '2030-05-05', dueDate: '2030-05-21' })
    ] }) });
  assert.equal(carryover.status, 200, await carryover.text());
  await clickControl(page.locator('#sync'));
  await page.getByRole('button', { name: 'Keep on prior date: Keep on prior date' }).waitFor();
  await page.getByRole('button', { name: 'Keep on prior date: Keep on prior date' }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).projected(await (await import('/inbox-store.js?v=9')).transact('alice')))[`dailyPlan:personal_2030-05-06`]?.carryoverDecisions.some(decision => decision.actionId === 'carryover-keep'));
  await page.getByRole('button', { name: 'Remove from daily plan: Remove only membership' }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).projected(await (await import('/inbox-store.js?v=9')).transact('alice')))['item:carryover-remove']?.plannedDay === null);
  await page.getByRole('button', { name: 'Move to selected date: Keep identity' }).waitFor();
  await page.getByRole('button', { name: 'Move to selected date: Keep identity' }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).projected(await (await import('/inbox-store.js?v=9')).transact('alice')))['item:carryover-move']?.plannedDay === '2030-05-06');
  await confirmed(page);
  const moved = documents.find(document => document.record?.id === 'carryover-move').record;
  assert.deepEqual({ status: moved.status, waitingOn: moved.waitingOn, dueDate: moved.dueDate, priority: moved.priority, timeRequired: moved.timeRequired, plannedDay: moved.plannedDay },
    { status: 'waiting', waitingOn: 'Alex', dueDate: '2030-05-20', priority: 'high', timeRequired: '45m', plannedDay: '2030-05-06' });
  assert.equal(documents.find(document => document.record?.id === 'carryover-keep').record.plannedDay, '2030-05-05');
  const removed = documents.find(document => document.record?.id === 'carryover-remove').record;
  assert.deepEqual({ status: removed.status, dueDate: removed.dueDate, plannedDay: removed.plannedDay }, { status: 'next', dueDate: '2030-05-21', plannedDay: null });
  assert.ok(documents.some(document => document.record?.type === 'dailyPlan' && document.record.planDay === '2030-05-05'));
  assert.deepEqual(documents.find(document => document.record?.type === 'dailyPlan' && document.record.planDay === '2030-05-06').record.carryoverDecisions.map(decision => decision.choice), ['keep', 'remove', 'move']);
});

test('Day exposes whole-plan stale conflicts and preserves unrelated queued work through both choices', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const day = '2031-02-03', planId = `personal_${day}`, before = { actionIds: [], loadAssessment: 'needs_assessment' }, initial = { actionIds: ['one', 'two'], loadAssessment: 'needs_assessment' };
  const seed = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({
    apiVersion: 1, accountId: 'alice', operationId: 'seed-conflict-plan', mutations: [
      currentCreate('item', 'one', { title: 'One', status: 'next', plannedDay: day }), currentCreate('item', 'two', { title: 'Two', status: 'next', plannedDay: day }),
      { type: 'planPreference', id: 'personal', action: 'create', expectedVersion: 0, fields: { workspaceId: 'personal', estimationMethod: 'tshirt' } },
      { type: 'dailyPlan', id: planId, action: 'create', expectedVersion: 0, fields: { workspaceId: 'personal', planDay: day, ...initial, carryoverDecisions: [], revisionHead: 'seed-plan-revision', revisionCount: 1 } },
      { type: 'dailyPlanRevision', id: 'seed-plan-revision', action: 'create', expectedVersion: 0, fields: { workspaceId: 'personal', planId, planDay: day, sequence: 1, operationKind: 'add', before, after: initial, carryoverDecision: null,
        estimates: initial.actionIds.map(actionId => ({ actionId, estimate: null })) } }
    ]
  }) });
  assert.equal(seed.status, 200, await seed.text());
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const contextA = await browser.newContext(), contextB = await browser.newContext();
  const pageA = await contextA.newPage(), pageB = await contextB.newPage();
  for (const page of [pageA, pageB]) {
    await page.goto(server.url + '/#plan'); await page.locator('#workspace').waitFor(); await confirmed(page);
    await waitForBrowser(page, async ({ id, plannedDay }) => {
      const local = await (await import('/inbox-store.js?v=9')).transact('alice');
      return local.records[`dailyPlan:${id}`]?.version === 1 && local.records['item:one']?.plannedDay === plannedDay && local.records['item:two']?.plannedDay === plannedDay;
    }, { id: planId, plannedDay: day });
    await page.locator('#planDay').fill(day);
    await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('#planDayActions > li[data-id]')].map(row => row.dataset.id)) === JSON.stringify(ids), ['one', 'two']);
  }

  await pageA.getByRole('button', { name: 'Move Two up from position 2' }).click();
  await waitForBrowser(pageA, async id => (await (await import('/inbox-store.js?v=9')).transact('alice')).records[`dailyPlan:${id}`]?.version === 2, planId); await confirmed(pageA);
  await pageB.getByLabel('Estimate One using T-shirt').selectOption('L');
  await pageB.locator('#failure').waitFor();
  assert.match(await pageB.locator('#comparison').textContent(), /My pending plan[\s\S]*"value":"L"[\s\S]*Server plan[\s\S]*1\. Two/);
  pageB.once('dialog', dialog => dialog.accept()); await pageB.locator('#discard').click(); await pageB.locator('#failure').waitFor({ state: 'hidden' });
  assert.deepEqual(await pageB.locator('#planDayActions > li[data-id]').evaluateAll(rows => rows.map(row => row.dataset.id)), ['two', 'one']);

  await pageA.locator('#planLoadAssessment').selectOption('full');
  await waitForBrowser(pageA, async id => (await (await import('/inbox-store.js?v=9')).transact('alice')).records[`dailyPlan:${id}`]?.version === 3, planId); await confirmed(pageA);
  await pageB.getByLabel('Estimate One using T-shirt').selectOption('M');
  await pageB.locator('#failure').waitFor();
  await pageB.locator('#planDay').fill('2031-02-04');
  await pageB.locator('#planQuickAdd input[name="title"]').fill('Unrelated next day');
  await pageB.locator('#planQuickAdd').getByRole('button', { name: 'Add to this day' }).click();
  await waitForBrowser(pageB, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).queue.length === 2);
  const peer = await contextB.newPage(); await peer.goto(server.url + '/help.html');
  let race;
  pageB.once('dialog', dialog => { race = (async () => {
    await peer.evaluate(async () => (await import('/inbox-store.js?v=9')).transact('alice', local => { local.records['item:one'].version++; }));
    await dialog.accept();
  })(); });
  await pageB.locator('#resolve').click(); await race;
  await pageB.waitForFunction(() => document.querySelector('#error').textContent.includes('related action changed again'));
  assert.equal((await local(pageB)).queue[0].failure.includes('conflicts with this save'), true, 'failed plan remains available for another reviewed attempt');
  await peer.evaluate(async () => (await import('/inbox-store.js?v=9')).transact('alice', local => { local.records['item:one'].version--; }));
  pageB.once('dialog', dialog => dialog.accept()); await pageB.locator('#resolve').click();
  await waitForBrowser(pageB, async id => {
    const local = await (await import('/inbox-store.js?v=9')).transact('alice');
    return local.records[`dailyPlan:${id}`]?.version === 4 && Object.values(local.records).some(record => record.title === 'Unrelated next day') && local.queue.length === 0;
  }, planId); await confirmed(pageB);
  const serverPlan = documents.find(document => document.record?.type === 'dailyPlan' && document.record.id === planId).record;
  assert.deepEqual(serverPlan.actionIds, ['two', 'one']);
  assert.equal(serverPlan.loadAssessment, 'needs_reassessment', 'rebasing an estimate change resets the latest accepted assessment');
  assert.deepEqual(documents.find(document => document.record?.type === 'item' && document.record.id === 'one').record.effortEstimate, { scale: 'tshirt', value: 'M' });
  assert.ok(documents.some(document => document.record?.type === 'item' && document.record.title === 'Unrelated next day'));
});
