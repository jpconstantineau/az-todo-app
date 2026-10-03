import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';
import { workflowSnapshot } from '../api/v1/reviews.mjs';
import { reviewHistory } from '../../html/reviews.js';
import { deviceExport, validateDeviceExport, readableExport, accountExport, validateAccountExport } from '../../html/inbox-export.js';
import { workspaceRecords } from '../../html/workspaces.js';
import { clickControl } from './navigation-helper.mjs';

const records = () => Object.fromEntries(documents.filter(doc => doc.kind === 'record').map(doc => [`${doc.record.type}:${doc.record.id}`, structuredClone(doc.record)]));
const create = (type, id, fields) => ({ type, id, action: 'create', expectedVersion: 0, fields });
const update = (record, fields) => ({ type: record.type, id: record.id, action: 'update', expectedVersion: record.version, fields });
const op = mutations => ({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations });
function decision(session, item, index, choice, fields) {
  const id = crypto.randomUUID(), sequence = (session.decisionCount || 0) + 1;
  const before = item ? workflowSnapshot(item) : {}, after = item ? workflowSnapshot({ ...item, ...fields }) : {};
  const decisionHeads = session.decisionHeads ? [...session.decisionHeads] : session.included.map(() => null);
  decisionHeads[index] = id;
  return op([update(session, { decisionHeads, decisionCount: sequence }), create('reviewDecision', id, {
    reviewId: session.id, sequence, index, choice, recordVersion: item?.version || 0, before,
    changes: Object.fromEntries(Object.entries(after).filter(([name, value]) => value !== before[name]))
  }), ...(fields ? [update(item, fields)] : [])]);
}
async function fixture(t) {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const post = async operation => {
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(operation) });
    return { status: response.status, body: await response.json() };
  };
  const commit = async operation => {
    const response = await post(operation);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'committed', JSON.stringify(response.body));
    return response;
  };
  return { ...server, post, commit, user: value => { user = value; } };
}

test('200-item review finishes with maximum-length IDs, waiting text, undo and redecision beyond 200 history entries', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const included = Array.from({ length: 200 }, (_, i) => ({ type: 'item', id: `task-${i}-`.padEnd(128, 'x') }));
  for (let i = 0; i < 200; i += 10) await f.commit(op(included.slice(i, i + 10).map(({ id }, offset) => create('item', id, {
    title: `Task ${i + offset}`, status: 'waiting', waitingOn: i + offset === 199 ? '界'.repeat(4000) : 'Supplier'
  }))));
  await f.commit(op([create('review', 'large', { reviewKind: 'weekly', reviewDay: '2026-10-03', included, decisions: [] })]));
  for (const [index, ref] of included.entries()) {
    const state = records(), item = state[`item:${ref.id}`];
    await f.commit(decision(state['review:large'], item, index, 'retain', { title: item.title }));
  }
  let state = records(), session = state['review:large'], item = state[`item:${included[199].id}`];
  assert.equal(session.decisionCount, 200);
  assert.equal(Buffer.byteLength(JSON.stringify(session)) > 32768, true, 'bounded heads fit even when 200 long IDs leave no room in the old record cap');
  const original = structuredClone(state[`reviewDecision:${session.decisionHeads[199]}`]);
  await f.commit(decision(session, item, 199, 'undo', { title: item.title }));
  state = records(); item = state[`item:${included[199].id}`];
  await f.commit(decision(state['review:large'], item, 199, 'defer', { status: 'deferred', startDate: '2026-10-09', startDateUtc: null }));
  state = records(); item = state[`item:${included[199].id}`];
  await f.commit(decision(state['review:large'], item, 199, 'undo', original.before));
  state = records(); item = state[`item:${included[199].id}`];
  assert.equal(item.waitingOn, '界'.repeat(4000)); assert.equal(item.status, 'waiting');
  await f.commit(decision(state['review:large'], item, 199, 'retain', { title: item.title }));
  state = records(); session = state['review:large'];
  assert.equal(session.decisionCount, 204);
  assert.deepEqual(state[`reviewDecision:${original.id}`], original);
  assert.equal(reviewHistory(session, state).length, 204);
  for (const ref of included) assert.equal(state[`item:${ref.id}`].waitingOn.length, ref === included[199] ? 4000 : 8);
  for (const record of Object.values(state)) assert.ok(Buffer.byteLength(JSON.stringify(record)) <= (record.type === 'review' ? 65536 : 32768));
  const exported = deviceExport('alice', { records: state, queue: [], draft: {}, after: 0 }, {});
  assert.deepEqual(validateDeviceExport(exported).warnings, []);
  assert.match(readableExport(exported), /reviewDecision/);
  const serverCopy = await accountExport('alice', async path => (await fetch(`${f.url}/api/v1/${path}`)).json());
  assert.deepEqual(validateAccountExport(serverCopy).warnings, []);
  assert.equal(serverCopy.state.records['review:large'].decisionCount, 204);
});

test('separate decisions preserve atomicity, retries, immutability, exact snapshots and workspace/account isolation', async t => {
  const f = await fixture(t);
  await f.commit(op([create('workspace', 'work', { title: 'Work' }), create('item', 'task', { title: 'Task', workspaceId: 'work' })]));
  await f.commit(op([create('review', 'weekly', { reviewKind: 'weekly', reviewDay: '2026-10-03', workspaceId: 'work', included: [{ type: 'item', id: 'task' }], decisions: [] })]));
  const state = records(), operation = decision(state['review:weekly'], state['item:task'], 0, 'drop', { status: 'dropped' });
  for (const remove of [0, 1, 2]) {
    const invalid = structuredClone(operation); invalid.mutations.splice(remove, 1);
    assert.equal((await f.post(invalid)).status, 400);
  }
  for (const field of ['before', 'changes']) {
    const invalid = structuredClone(operation); invalid.mutations[1].fields[field].waitingOn = 'forged';
    assert.equal((await f.post(invalid)).status, 400);
  }
  faults.batchIndex = 2; assert.equal((await f.post(operation)).status, 503);
  assert.equal(records()['review:weekly'].version, 1); assert.equal(records()['item:task'].status, 'inbox');
  const committed = await f.commit(operation); assert.deepEqual(await f.post(operation), committed);
  const history = records()[`reviewDecision:${operation.mutations[1].id}`];
  assert.ok(workspaceRecords(records(), 'work')[`reviewDecision:${history.id}`]);
  assert.equal(workspaceRecords(records(), 'personal')[`reviewDecision:${history.id}`], undefined);
  assert.equal((await f.post(op([update(history, operation.mutations[1].fields)]))).status, 400);
  assert.equal((await f.post(op([{ type: history.type, id: history.id, action: 'delete', expectedVersion: 1 }]))).status, 400);
  let latest = records();
  assert.equal((await f.post(op([update(latest['review:weekly'], { decisions: [] })]))).status, 400, 'old clients cannot overwrite new history');
  const undo = decision(latest['review:weekly'], latest['item:task'], 0, 'undo', history.before);
  await f.commit(op([update(latest['item:task'], { title: 'Changed elsewhere' })]));
  assert.equal((await f.post(undo)).body.status, 'conflict');
  latest = records();
  assert.equal((await f.post(decision(latest['review:weekly'], latest['item:task'], 0, 'undo', history.before))).status, 400);
  f.user('bob');
  assert.equal((await fetch(f.url + `/api/v1/records?accountId=bob&type=reviewDecision&id=${history.id}`)).status, 404);
  assert.equal((await f.post(operation)).status, 409);
});

test('a legacy review at its byte limit resumes without rewriting history', async t => {
  const f = await fixture(t), included = Array.from({ length: 200 }, (_, i) => ({ type: 'item', id: `task-${i}` }));
  for (let i = 0; i < 200; i += 20) await f.commit(op(included.slice(i, i + 20).map(ref => create('item', ref.id, { title: ref.id, status: 'next' }))));
  await f.commit(op([create('review', 'legacy', { reviewKind: 'weekly', reviewDay: '2026-10-03', included, decisions: [] })]));
  let stopped;
  for (const [index, ref] of included.entries()) {
    const state = records(), session = state['review:legacy'], item = state[`item:${ref.id}`];
    const response = await f.post(op([update(session, { decisions: [...session.decisions, { index, choice: 'retain', recordVersion: item.version, before: workflowSnapshot(item), after: workflowSnapshot(item) }] }), update(item, { title: item.title })]));
    if (response.status === 400) { stopped = index; break; }
    assert.equal(response.status, 200);
  }
  assert.ok(stopped > 0 && stopped < 200);
  const preserved = records()['review:legacy'].decisions;
  for (let index = stopped; index < 200; index++) {
    const state = records(), item = state[`item:${included[index].id}`];
    await f.commit(decision(state['review:legacy'], item, index, 'retain', { title: item.title }));
  }
  const state = records();
  assert.deepEqual(state['review:legacy'].decisions, preserved);
  assert.equal(reviewHistory(state['review:legacy'], state).length, 200);
  await f.commit(decision(state['review:legacy'], state['item:task-0'], 0, 'undo', { title: 'task-0' }));
});

test('more than 200 records continue in bounded review batches, survive offline reload and resume on another device', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 201; i += 20) await f.commit(op(Array.from({ length: Math.min(20, 201 - i) }, (_, offset) => create('item', `task-${i + offset}`, { title: `Task ${i + offset}`, status: 'next' }))));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const confirmed = async page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await page.goto(f.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await clickControl(page.locator('#openReviews')); await page.locator('#startWeekly').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 200')); await confirmed(page);
  assert.match(await page.locator('#reviewCapacity').textContent(), /1 more eligible/);
  assert.equal(await page.locator('#reviewNextBatch').isDisabled(), true);
  const session = Object.values(records()).find(record => record.type === 'review');
  // Finish most of the batch through production handlers, then exercise the UI boundary.
  for (let index = 0; index < 199; index++) {
    const state = records(), item = state[`item:${session.included[index].id}`];
    await f.commit(decision(state[`review:${session.id}`], item, index, 'retain', { title: item.title }));
  }
  await page.locator('#closeReviews').click(); await clickControl(page.locator('#sync')); await confirmed(page);
  await clickControl(page.locator('#openReviews'));
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('199 of 200'));
  await page.locator('#reviewRetain').click(); await page.waitForFunction(() => !document.querySelector('#reviewNextBatch').disabled); await confirmed(page);
  assert.match(await page.locator('#reviewProgress').textContent(), /Batch complete/);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true); await page.locator('#reviewNextBatch').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 1'));
  await page.locator('#reviewRetain').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 1'));
  await page.reload(); await page.locator('#workspace').waitFor(); await clickControl(page.locator('#openReviews'));
  assert.match(await page.locator('#reviewProgress').textContent(), /1 of 1/);
  await page.locator('#reviewUndo').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 1'));
  await page.locator('#reviewRetain').click(); await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 1'));
  await page.locator('#closeReviews').click(); await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  const continuation = Object.values(records()).find(record => record.previousReviewId === session.id);
  assert.equal(continuation.included.length, 1); assert.equal(continuation.decisionCount, 3);
  assert.equal(new Set([...session.included, ...continuation.included].map(ref => ref.id)).size, 201);
  const otherContext = await browser.newContext(), other = await otherContext.newPage();
  await other.goto(f.url); await other.locator('#workspace').waitFor(); await confirmed(other);
  await clickControl(other.locator('#openReviews')); await other.locator('#reviewSessions').selectOption(session.id);
  await other.locator('#reviewNextBatch').click();
  assert.match(await other.locator('#reviewProgress').textContent(), /1 of 1/);
  assert.equal(Object.values(records()).filter(record => record.type === 'review').length, 2);
  for (const width of [320, 390, 1440]) {
    await other.setViewportSize({ width, height: 900 });
    assert.ok(await other.locator('#reviews').evaluate(el => el.scrollWidth <= el.clientWidth));
  }
  assert.deepEqual(errors, []);
});
