import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { workflowSnapshot } from '../api/v1/reviews.mjs';
import { clickControl } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { currentCreate } from './current-record.mjs';

const records = () => documents.filter(doc => doc.kind === 'record').map(doc => doc.record);
const create = currentCreate;
const update = (record, fields) => ({ type: record.type, id: record.id, action: 'update', expectedVersion: record.version, fields });
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const operation = mutations => ({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations });
const post = async (url, body) => {
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test('complete and next review decisions require exact paired edits, preserve dates, and undo safely', async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const get = (type, id) => structuredClone(records().find(record => record.type === type && record.id === id));
  assert.equal((await post(server.url, operation([
    create('item', 'waiting', { title: 'Quote', status: 'waiting', waitingOn: 'Supplier', reviewDate: '2026-10-12', dueDate: '2026-10-20', plannedDay: '2026-10-15' }),
    create('project', 'project', { title: 'Garage', outcome: 'Ready for winter' })
  ]))).status, 200);
  await post(server.url, operation([create('review', 'review', { reviewKind: 'weekly', reviewDay: '2026-10-03', included: [{ type: 'item', id: 'waiting' }, { type: 'project', id: 'project' }], decisionHeads: [null, null], decisionCount: 0 })]));
  function decision(choice, fields, index = 0) {
    const session = get('review', 'review'), target = get(index ? 'project' : 'item', index ? 'project' : 'waiting');
    const before = workflowSnapshot(target), after = workflowSnapshot({ ...target, ...fields });
    const id = crypto.randomUUID(), heads = [...session.decisionHeads]; heads[index] = id;
    return operation([update(session, { decisionHeads: heads, decisionCount: session.decisionCount + 1 }),
      create('reviewDecision', id, { reviewId: session.id, sequence: session.decisionCount + 1, index, choice, recordVersion: target.version, before,
        changes: Object.fromEntries(Object.entries(after).filter(([name, value]) => value !== before[name])) }), update(target, fields)]);
  }
  const original = workflowSnapshot(get('item', 'waiting'));
  for (const choice of ['complete', 'next']) {
    const fields = { status: choice === 'complete' ? 'completed' : 'next' };
    const body = decision(choice, fields);
    const missing = structuredClone(body); missing.mutations.pop();
    assert.equal((await post(server.url, missing)).status, 400);
    const forged = decision(choice, { ...fields, dueDate: null });
    assert.equal((await post(server.url, forged)).status, 400);
    assert.equal((await post(server.url, decision(choice, { title: 'Garage' }, 1))).status, 400);
    const result = await post(server.url, body);
    assert.equal(result.status, 200); assert.deepEqual(await post(server.url, body), result);
    const item = get('item', 'waiting');
    assert.equal(item.status, fields.status); assert.equal(item.dueDate, '2026-10-20'); assert.equal(item.plannedDay, '2026-10-15');
    assert.equal(item.waitingOn, 'Supplier'); assert.equal(item.reviewDate, '2026-10-12');
    assert.equal((await post(server.url, decision('undo', original))).status, 200);
    assert.deepEqual(workflowSnapshot(get('item', 'waiting')), original);
  }
  const stale = decision('complete', { status: 'completed' });
  await post(server.url, operation([update(get('item', 'waiting'), { title: 'Changed elsewhere' })]));
  assert.equal((await post(server.url, stale)).body.status, 'conflict');
  assert.equal(get('review', 'review').decisionCount, 4);
  assert.equal(get('item', 'waiting').status, 'waiting');
});

test('review actions edit, clarify and add project actions in place with offline progress and undo', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  await post(server.url, operation([
    create('workspace', 'other', { title: 'Other' }),
    create('project', 'garage', { title: 'Garage', outcome: 'Ready for winter' }),
    create('item', 'shelf', { title: 'Sort shelf', status: 'next', projectId: 'garage' }),
    create('item', 'someday', { title: 'Build bench', status: 'someday', projectId: 'garage', dueDate: '2027-01-01' }),
    create('item', 'inbox', { title: 'Unsorted idea' })
  ]));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await clickControl(page.locator('#openReviews')); await page.locator('#startWeekly').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 4')); await confirmed(page);
  const session = records().find(record => record.type === 'review');
  const index = id => String(session.included.findIndex(record => record.id === id));
  await context.setOffline(true);
  await page.locator('#reviewRecord').selectOption(index('garage'));
  assert.match(await page.locator('#reviewProjectSummary').textContent(), /1 next action/);
  assert.equal(await page.locator('#reviewProjectActions button').count(), 2);
  assert.equal(await page.locator('#reviewComplete').isDisabled(), true);
  await page.locator('#reviewEdit').click(); await page.locator('#editor').waitFor();
  await page.locator('#edit [name=outcome]').fill('Garage ready for snow');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click(); await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#reviewRecord').inputValue(), index('garage'));
  assert.match(await page.locator('#reviewDetails').textContent(), /Garage ready for snow/);
  await page.locator('#reviewProjectActions').getByRole('button', { name: 'Edit Sort shelf', exact: true }).click();
  await page.locator('#edit [name=description]').fill('Top shelf first');
  await page.locator('#cancelEdit').click(); await page.locator('#reviewEdit').click();
  await page.locator('#editor').waitFor();
  assert.equal(await page.locator('#edit [name=title]').inputValue(), 'Sort shelf');
  assert.equal(await page.locator('#edit [name=description]').inputValue(), 'Top shelf first');
  assert.match(await page.locator('#editError').textContent(), /draft is still here/);
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click(); await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#reviewRecord').inputValue(), index('garage'));
  await page.locator('#reviewAddAction').click();
  assert.equal(await page.locator('#edit [name=projectId]').inputValue(), 'garage');
  assert.equal(await page.locator('#edit [name=status]').inputValue(), 'next');
  await page.locator('#edit [name=title]').fill('Sweep garage');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click(); await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#reviewRecord').inputValue(), index('garage'));
  assert.match(await page.locator('#reviewProjectSummary').textContent(), /2 next action/);
  if (process.env.REVIEW_ACTION_SCREENSHOT) {
    await page.locator('#reviewProject').scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.REVIEW_ACTION_SCREENSHOT });
  }
  await page.locator('#reviewRecord').selectOption(index('inbox')); await page.locator('#reviewClarify').click();
  await page.locator('#clarifier').waitFor(); await page.locator('#clarifyStop').click();
  assert.equal(await page.locator('#reviewRecord').inputValue(), index('inbox'));
  assert.equal(await page.locator('#reviewClarify').evaluate(el => document.activeElement === el), true);
  await page.locator('#reviewRecord').selectOption(index('someday')); await page.locator('#reviewNext').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 4'));
  await page.locator('#reviewRecord').selectOption(index('someday')); await page.locator('#reviewUndo').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 4'));
  assert.match(await page.locator('#reviewDetails').textContent(), /Status: someday/);
  await page.locator('#reviewRecord').selectOption(index('shelf')); await page.locator('#reviewComplete').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 4'));
  await page.locator('#reviewRecord').selectOption(index('garage')); await page.locator('#reviewDefer').fill('2027-02-01');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=7')).transact('alice')).draft.review?.deferUntil === '2027-02-01');
  await page.reload(); await page.locator('#workspace').waitFor(); await clickControl(page.locator('#openReviews'));
  assert.equal(await page.locator('#reviewRecord').inputValue(), index('garage'));
  assert.equal(await page.locator('#reviewDefer').inputValue(), '2027-02-01');
  assert.match(await page.locator('#reviewProgress').textContent(), /1 of 4/);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.locator('#reviews').evaluate(el => el.scrollWidth <= el.clientWidth));
  }
  await page.locator('#reviewRecord').selectOption(index('shelf')); await page.locator('#reviewUndo').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 4'));
  await page.locator('#closeReviews').click(); await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(records().find(record => record.id === 'shelf').status, 'next');
  assert.equal(records().find(record => record.id === 'shelf').description, 'Top shelf first');
  assert.equal(records().find(record => record.id === 'someday').dueDate, '2027-01-01');
  assert.equal(records().filter(record => record.title === 'Sweep garage').length, 1);
  await clickControl(page.locator('#openReviews')); await page.locator('#startDaily').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('daily review: 0 of 2'));
  await page.locator('#reviewComplete').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('daily review: 1 of 2')); await confirmed(page);
  assert.equal(records().filter(record => record.type === 'item' && record.status === 'completed').length, 1);
  // A delayed position save must not reopen tools after the user stops reviewing.
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
      const delay = this.mode === 'readwrite';
      if (delay) Object.defineProperty(IDBTransaction.prototype, 'oncomplete', descriptor);
      descriptor.set.call(this, delay ? function (event) { window.releaseReviewSave = () => callback.call(this, event); } : callback);
    } });
  });
  await page.locator('#reviewEdit').click(); await page.waitForFunction(() => !!window.releaseReviewSave);
  await page.locator('#appMenu > summary').click();
  await page.locator('#workspaceSelect').selectOption('other');
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Wait for the device save'));
  assert.equal(await page.locator('#workspaceSelect').inputValue(), 'personal');
  await page.locator('#closeReviews').click(); await page.evaluate(() => window.releaseReviewSave());
  await page.waitForFunction(() => !document.querySelector('#reviewSessions').disabled);
  assert.equal(await page.locator('#editor').isVisible(), false);
  assert.deepEqual(errors, []);
});
