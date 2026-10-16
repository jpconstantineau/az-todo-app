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

test('planner refresh preserves native controls, selection and keyboard removal destinations', { timeout: 60000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  assert.equal((await post(server.url, [mutation('project', 'launch', 0, { title: 'Launch', outcome: 'Customers can use it' })])).status, 200);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.url + '/#work');
  await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.locator('#view').selectOption('project:launch');
  await clickControl(page.getByRole('button', { name: 'Plan project Launch' }));
  const rows = page.locator('.project-plan-candidate'), add = page.locator('#addProjectPlanCandidate');
  for (const [title, kind] of [['Prepare launch', 'action'], ['Interview users', 'learning'], ['Publish guide', 'brainstorm']]) {
    await add.focus(); await page.keyboard.press('Enter');
    assert.ok(await rows.last().locator('input').evaluate(input => document.activeElement === input));
    await rows.last().locator('input').fill(title); await rows.last().locator('select').selectOption(kind);
  }
  await waitForBrowser(page, async () => {
    const draft = (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning;
    return draft?.candidates.length === 3 && draft.candidates.at(-1).title === 'Publish guide';
  });
  const before = (await local(page)).draft.projectPlanning;
  // Heading mutation marks the actual global render caused by a same-account refresh.
  const refresh = () => page.evaluate(() => new Promise(resolve => {
    const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
    observer.observe(document.querySelector('#projectPlanningHeading'), { childList: true });
    const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close();
  }));
  await refresh();
  await page.evaluate(() => {
    window.plannerStatusChanges = 0;
    new MutationObserver(changes => { window.plannerStatusChanges += changes.length; })
      .observe(document.querySelector('#projectPlanningStatus'), { childList: true });
  });
  const title = rows.first().locator('input');
  await title.focus();
  await title.evaluate(input => { window.plannerControl = input; input.setSelectionRange(2, 6); });
  await refresh();
  assert.deepEqual(await title.evaluate(input => [input === window.plannerControl, document.activeElement === input, input.selectionStart, input.selectionEnd, input.value]),
    [true, true, 2, 6, 'Prepare launch']);
  assert.equal(await page.evaluate(() => window.plannerStatusChanges), 0, 'unchanged refresh does not repeat the live status');
  await page.keyboard.type('X');
  await page.keyboard.press('Tab');
  const select = rows.first().locator('select');
  assert.ok(await select.evaluate(control => document.activeElement === control));
  await select.evaluate(control => { window.plannerControl = control; }); await refresh();
  assert.deepEqual(await select.evaluate(control => [control === window.plannerControl, document.activeElement === control, control.value]), [true, true, 'action']);
  await page.keyboard.press('Tab');
  const remove = rows.first().locator('button');
  await remove.evaluate(control => { if (document.activeElement !== control) throw new Error('Tab must reach Remove'); window.plannerControl = control; });
  await refresh();
  assert.ok(await remove.evaluate(control => control === window.plannerControl && document.activeElement === control));
  await page.keyboard.press('Shift+Tab'); assert.ok(await select.evaluate(control => document.activeElement === control));
  const outcome = page.locator('#projectPlanOutcome');
  await outcome.focus(); await outcome.evaluate(input => input.setSelectionRange(1, 5)); await refresh();
  assert.deepEqual(await outcome.evaluate(input => [document.activeElement === input, input.selectionStart, input.selectionEnd]), [true, 1, 5]);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning?.candidates[0].title === 'PrXe launch');
  assert.deepEqual((await local(page)).draft.projectPlanning.candidates, before.candidates.map((candidate, index) => index ? candidate : { ...candidate, title: 'PrXe launch' }));

  // Keep the removal journal pending, then choose another valid control before it finishes.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('todo-inbox-v1', 1); request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('accounts', 'readwrite'), store = transaction.objectStore('accounts');
      window.releasePlannerWrite = false;
      window.plannerWriteFinished = new Promise(done => { transaction.oncomplete = () => { db.close(); done(); }; });
      const hold = () => { const get = store.get('account:alice'); get.onsuccess = () => { resolve(); if (!window.releasePlannerWrite) hold(); }; };
      hold();
    };
  }));
  await rows.nth(1).locator('button').focus(); await page.keyboard.press('Enter');
  assert.ok(await rows.nth(1).locator('input').evaluate(input => document.activeElement === input), 'middle removal focuses next title');
  await outcome.focus(); await page.evaluate(async () => { window.releasePlannerWrite = true; await window.plannerWriteFinished; });
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning?.candidates.length === 2);
  assert.ok(await outcome.evaluate(input => document.activeElement === input), 'journal completion respects a later focus choice');
  assert.deepEqual((await local(page)).draft.projectPlanning.candidates.map(candidate => candidate.id), [before.candidates[0].id, before.candidates[2].id]);
  await rows.last().locator('button').focus(); await page.keyboard.press('Enter');
  assert.ok(await rows.first().locator('input').evaluate(input => document.activeElement === input), 'last removal focuses previous title');
  await rows.first().locator('button').focus(); await page.keyboard.press('Enter');
  assert.ok(await add.evaluate(control => document.activeElement === control), 'only removal focuses Add');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning?.candidates.length === 0);
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(documents.filter(row => ['item', 'projectPlanRevision'].includes(row.record?.type)).length, 0);

  await page.evaluate(async () => {
    await (await import('/inbox-store.js?v=15')).transact('alice', state => {
      state.draft.projectPlanning.sections.desiredEvidence = 'Earlier evidence';
    });
  });
  await page.reload(); await page.locator('#projectPlanner').waitFor(); await confirmed(page);
  await page.locator('#projectPlanEarlierNotes summary').click();
  const evidence = page.locator('#projectPlanEvidence');
  await evidence.fill('');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning?.sections.desiredEvidence === '');
  await refresh();
  assert.ok(await evidence.isVisible(), 'clearing the last legacy note keeps its section reachable during refresh');
  assert.ok(await evidence.evaluate(input => document.activeElement === input), 'refresh keeps focus on the cleared legacy note');
  await page.keyboard.type('Revised evidence');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning?.sections.desiredEvidence === 'Revised evidence');
});

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
  assert.equal(await page.locator('#projectPlanOutcome').inputValue(), 'Customers can use it');
  await page.locator('#projectPlanOutcome').evaluate(input => { if (document.activeElement !== input) throw new Error('Outcome must receive initial focus'); });
  assert.deepEqual(await page.locator('#projectPlanningForm h3').allTextContents(), ['Outcome', 'Purpose & principles', 'Brainstorm — Candidate ideas', 'Organize', 'Next actions']);
  assert.equal(await page.locator('#projectPlanEarlierNotes').isVisible(), false);
  await page.locator('#closeProjectPlanning').click();
  assert.equal((await local(page)).draft.projectPlanning ?? null, null, 'opening and closing an untouched planner creates no draft');
  await clickControl(opener);
  await page.locator('[name=purposePrinciples]').fill('Discard this draft');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning?.sections.purposePrinciples === 'Discard this draft');
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.locator('#discardProjectPlanning').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact('alice')).draft.projectPlanning == null);
  await page.evaluate(async () => {
    const { transact } = await import('/inbox-store.js?v=23');
    await transact('alice', state => {
      state.draft.projectPlanning = { version: 1, projectId: 'launch', sourceVersion: 1, previousRevisionId: null, open: true,
        sections: { purposePrinciples: '', desiredEvidence: 'A customer completes setup', organizationApproach: '', unresolvedQuestions: 'Which step is unclear?' }, candidates: [] };
    });
  });
  await page.reload(); await page.locator('#projectPlanner').waitFor(); await confirmed(page);
  assert.equal(await page.locator('#projectPlanOutcome').inputValue(), 'Customers can use it', 'legacy drafts resume from the canonical project outcome');
  await page.locator('#projectPlanEarlierNotes summary').click();
  assert.equal(await page.locator('[name=desiredEvidence]').inputValue(), 'A customer completes setup');
  assert.equal(await page.locator('[name=unresolvedQuestions]').inputValue(), 'Which step is unclear?');
  await page.locator('#projectPlanOutcome').fill('  ');
  await page.locator('#acceptProjectPlan').click();
  await page.waitForFunction(() => document.querySelector('#projectPlanningStatus').textContent.includes('successful outcome'));
  assert.match(await page.locator('#projectPlanningStatus').textContent(), /successful outcome/, 'validation errors survive the final redraw');
  await page.locator('#projectPlanOutcome').fill('A customer independently completes setup');
  await page.locator('[name=purposePrinciples]').fill('Help customers finish a first run');
  await page.locator('[name=organizationApproach]').fill('Learn, then publish');
  const ideas = [['Consider a video', 'brainstorm'], ['Publish the guide', 'action'], ['Interview pilot users', 'learning'], ...Array.from({ length: 17 }, (_, index) => [`Next step ${index + 1}`, 'action'])];
  for (const [title, kind] of ideas) {
    await page.locator('#addProjectPlanCandidate').click();
    const row = page.locator('.project-plan-candidate').last();
    await row.locator('input').fill(title); await row.locator('select').selectOption(kind);
  }
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=15')).transact('alice');
    return state.draft.projectPlanning?.sections.purposePrinciples === 'Help customers finish a first run' && state.draft.projectPlanning.candidates.length === 20 && state.draft.projectPlanning.candidates.at(-1).kind === 'action';
  });
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true); await page.reload(); await page.locator('#projectPlanner').waitFor();
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), 'Help customers finish a first run');
  assert.equal(await page.locator('#projectPlanOutcome').inputValue(), 'A customer independently completes setup');
  assert.deepEqual(await page.locator('.project-plan-candidate input').evaluateAll(inputs => inputs.map(input => input.value)), ideas.map(([title]) => title));
  await page.locator('#acceptProjectPlan').click();
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=15')).transact('alice'), entry = state.queue[0];
    return state.draft.projectPlanning === null && entry?.operation.mutations.filter(mutation => mutation.type === 'item').length === 19 &&
      entry.operation.mutations.some(mutation => mutation.type === 'projectPlanRevision');
  });
  const pending = await local(page), operation = pending.queue[0].operation;
  assert.equal(operation.mutations.length, 21);
  assert.equal(operation.mutations[0].fields.outcome, 'A customer independently completes setup');
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
  assert.equal(documents.find(row => row.record?.type === 'project' && row.record.id === 'launch').record.outcome, 'A customer independently completes setup');
  assert.equal(documents.filter(row => row.UserID === 'alice' && row.record?.type === 'item' && row.record.projectId === 'launch').length, 19);

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
  assert.equal(await page.locator('#projectPlanOutcome').inputValue(), 'A customer independently completes setup');
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
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact(null)).accountId === 'bob' && !document.querySelector('#workspace').hidden);
  await confirmed(page);
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), '', 'another account cannot expose the planning draft');
  browserUser = 'alice'; await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=15')).transact(null)).accountId === 'alice' && !document.querySelector('#workspace').hidden);
  await confirmed(page);
  await showView(page, 'work');
  await page.locator('#view').selectOption('project:launch', { force: true }); await clickControl(opener);
  assert.equal(await page.locator('[name=purposePrinciples]').inputValue(), 'Exact conflicted purpose');
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.locator('#acceptProjectPlan').click(); await page.locator('#recovery').waitFor();
  await page.waitForFunction(() => document.querySelector('#projectPlanningStatus').textContent.includes('latest planning draft was not saved'));
  assert.match(await page.locator('#projectPlanningStatus').textContent(), /latest planning draft was not saved/, 'journal errors remain visible');
  assert.match(await page.locator('#recoveryText').inputValue(), /Exact conflicted purpose/);
  assert.equal((await local(page)).queue.length, 0, 'a failed journal cannot queue a partial plan acceptance');
  assert.deepEqual(errors, []);
});

test('planner capacity errors remain visible and preserve the saved draft without a queue entry', { timeout: 30000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  assert.equal((await post(server.url, [mutation('project', 'launch', 0, { title: 'Launch', outcome: 'Customers can use it' })])).status, 200);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage();
  let releasePull, pullRequested;
  const pullHeld = new Promise(resolve => { pullRequested = resolve; });
  const pullReleased = new Promise(resolve => { releasePull = resolve; });
  await page.route('**/api/v1/changes?**', async route => {
    const response = await route.fetch(); pullRequested();
    await pullReleased; await route.fulfill({ response });
  });
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page); await pullHeld;
  assert.equal((await local(page)).records['project:launch'], undefined, 'the empty-queue label precedes the delayed project pull');
  releasePull();
  // The first project pull journals its normalized Execute selection. Let that
  // exact write finish before seeding a draft behind the application's live state.
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=23')).transact('alice');
    return state.records['project:launch']?.version === 1 && state.draft.navigation?.execute?.kind === 'project';
  });
  await page.evaluate(async () => {
    const { transact } = await import('/inbox-store.js?v=23');
    await transact('alice', state => {
      state.draft.projectPlanning = { version: 1, projectId: 'launch', sourceVersion: 1, previousRevisionId: null, open: true,
        sections: { outcome: '界'.repeat(4000), purposePrinciples: '界'.repeat(4000), organizationApproach: '界'.repeat(4000), desiredEvidence: '', unresolvedQuestions: '' },
        candidates: Array.from({ length: 50 }, (_, index) => ({ id: `idea-${index}`, title: '界'.repeat(200), kind: 'action' })) };
    });
  });
  await page.reload(); await page.locator('#projectPlanner').waitFor(); await confirmed(page);
  const draft = (await local(page)).draft.projectPlanning;
  await page.locator('#acceptProjectPlan').click();
  await page.waitForFunction(() => document.querySelector('#projectPlanningStatus').textContent.includes('storage request limit'));
  assert.equal(await page.locator('#projectPlanOutcome').inputValue(), draft.sections.outcome);
  assert.deepEqual((await local(page)).draft.projectPlanning, draft);
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(documents.filter(row => row.record?.type === 'projectPlanRevision').length, 0);
});
