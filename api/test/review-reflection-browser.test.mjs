import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { currentCreate } from './current-record.mjs';
import { clickControl } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

const create = currentCreate;
const op = mutations => ({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations });
const records = () => documents.filter(document => document.kind === 'record').map(document => document.record);
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

test('session reflection drafts span review batches, save canonical follow-ups offline, and connect to Plan', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const commit = async operation => {
    const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(operation) });
    assert.equal(response.status, 200, await response.text());
  };
  await commit(op([create('review', 'root-review', { reviewKind: 'weekly', reviewDay: '2026-10-07', included: [], decisionHeads: [], decisionCount: 0 }),
    create('list', 'role', { title: 'Parent role', kind: 'area' }), create('project', 'project', { title: 'Outcome', outcome: '', status: 'draft' }),
    create('item', 'planned', { title: 'Planned action', status: 'completed', plannedDay: '2026-10-07' })]));
  await commit(op([create('review', 'next-review', { reviewKind: 'weekly', reviewDay: '2026-10-07', included: [], decisionHeads: [], decisionCount: 0, previousReviewId: 'root-review' }),
    create('dailyPlan', 'personal_2026-10-07', { workspaceId: 'personal', planDay: '2026-10-07', actionIds: ['planned'], loadAssessment: 'fits', carryoverDecisions: [], revisionHead: 'plan-revision', revisionCount: 1 }),
    create('dailyPlanRevision', 'plan-revision', { workspaceId: 'personal', planId: 'personal_2026-10-07', planDay: '2026-10-07', sequence: 1, operationKind: 'add',
      before: { actionIds: [], loadAssessment: 'needs_assessment' }, after: { actionIds: ['planned'], loadAssessment: 'fits' }, carryoverDecision: null,
      estimates: [{ actionId: 'planned', estimate: null }] })]));

  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await clickControl(page.locator('#openReviews')); await page.locator('#reviewSessions').selectOption('next-review');
  await page.locator('#reviewReflection').evaluate(element => { element.open = true; element.dispatchEvent(new Event('toggle')); });
  for (const prompt of [
    'What still has your attention that is not captured here?',
    'Looking back and ahead on your calendar, what needs an action, preparation, or follow-up?',
    'Where is your current mix of responsibilities and outcomes out of balance?',
    'What did you expect to do, what actually happened, and what should change next?'
  ]) await page.getByText(prompt, { exact: true }).waitFor();
  assert.match(await page.locator('#reviewRoleSummary').textContent(), /1 role\/area collection.*1 active or unfinished project/);
  assert.match(await page.locator('#reviewPlanSummary').textContent(), /1 ordered action.*1 completed, 0 unfinished/);
  const mental = page.locator('[data-reflection-prompt="mentalSweep"]');
  await mental.locator('select').selectOption('answered'); await mental.locator('textarea').fill('Book the follow-up room.');
  await page.locator('[data-reflection-prompt="calendarCheck"] select').selectOption('skipped');
  await page.locator('#reviewConclusion').fill('Protect preparation time next week.');
  await page.locator('#reviewFollowUp input[name="title"]').fill('Book follow-up room');
  await page.locator('#reviewFollowUp textarea[name="description"]').fill('Ask facilities about access.');
  await waitForBrowser(page, async () => {
    const draft = (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.review?.reflection;
    return draft?.rootReviewId === 'root-review' && draft.prompts.mentalSweep.notes === 'Book the follow-up room.' && draft.followUp?.id;
  });
  const before = await page.evaluate(async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.review.reflection);
  await page.locator('#closeReviews').click(); await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor();
  await clickControl(page.locator('#openReviews'));
  assert.equal(await page.locator('#reviewSessions').inputValue(), 'next-review');
  assert.equal(await mental.locator('select').inputValue(), 'answered');
  assert.equal(await mental.locator('textarea').inputValue(), 'Book the follow-up room.');
  assert.equal(await page.locator('#reviewFollowUp input[name="title"]').inputValue(), 'Book follow-up room');
  await page.locator('#reviewReflection').evaluate(element => { element.open = true; });
  await page.locator('#reviewSaveFollowUp').click();
  await waitForBrowser(page, async id => {
    const { transact, projected } = await import('/inbox-store.js?v=9'), local = await transact('alice'), records = projected(local);
    return records[`item:${id}`]?.title === 'Book follow-up room' && Object.values(records).some(record => record.type === 'reviewReflection' && record.reviewId === 'root-review' && record.followUpIds.includes(id));
  }, before.followUp.id);
  assert.equal((await page.evaluate(async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.review.reflection.followUp)), null);
  await page.reload(); await page.locator('#workspace').waitFor(); await clickControl(page.locator('#openReviews'));
  assert.match(await page.locator('#reviewFollowUps').textContent(), /Book follow-up room · inbox/);
  assert.equal(await page.locator('#reviewSessions').inputValue(), 'next-review');
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(records().find(record => record.id === 'root-review').version, 1);
  assert.equal(records().find(record => record.id === 'next-review').version, 1);
  assert.equal(records().find(record => record.id === before.followUp.id).title, 'Book follow-up room');
  await page.locator('#reviewReflection').evaluate(element => { element.open = true; });
  await page.locator('#reviewOpenDayPlan').click();
  await page.waitForFunction(() => location.hash === '#plan');
  assert.equal(await page.locator('#planDay').inputValue(), '2026-10-07');
  await clickControl(page.locator('#openReviews'));
  await page.locator('#reviewReflection').evaluate(element => { element.open = true; });
  for (const label of ['Edit', 'Clarify', 'Open in Plan']) await page.locator('#reviewFollowUps').getByRole('button', { name: label }).waitFor();
  assert.ok(await page.locator('#reviews').evaluate(element => element.scrollWidth <= element.clientWidth));
  for (const control of await page.locator('#reviewReflection button, #reviewReflection select, #reviewReflection input').all()) {
    assert.ok(await control.evaluate(element => element.getBoundingClientRect().height >= 44));
  }
  assert.deepEqual(errors, []);
});
