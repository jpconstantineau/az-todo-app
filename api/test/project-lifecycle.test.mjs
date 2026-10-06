import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { enqueue, rememberEdit, undoEdit, projected } from '../../html/inbox-store.js';
import { currentCreate } from './current-record.mjs';

const records = () => documents.filter(doc => doc.kind === 'record').map(doc => doc.record);
const get = id => records().find(record => record.id === id);
const create = currentCreate;
const update = (record, fields) => ({ type: record.type, id: record.id, action: 'update', expectedVersion: record.version, fields });
const operation = mutations => ({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations });
async function post(url, body) {
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

test('project lifecycle validates states, preserves linked history, and conflicts without overwriting', async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  assert.equal((await post(server.url, operation([create('project', 'draft', { title: 'Kitchen', status: 'draft' })]))).status, 200);
  assert.equal(get('draft').outcome, '');
  assert.equal((await post(server.url, operation([update(get('draft'), { status: 'active' })]))).status, 400);
  assert.equal((await post(server.url, operation([update(get('draft'), { outcome: 'Kitchen is usable', status: 'active' })]))).status, 200);
  assert.equal((await post(server.url, operation([
    create('project', 'project', { title: 'Garage', outcome: 'Ready for winter', description: 'Keep notes' }),
    create('item', 'action', { title: 'Sort tools', projectId: 'project', status: 'next' })
  ]))).status, 200);
  assert.equal(get('project').status, 'active');
  const original = structuredClone(get('project')), action = structuredClone(get('action'));
  for (const status of ['next', 'paused', '', null, 123]) {
    assert.equal((await post(server.url, operation([update(get('project'), { status })]))).status, 400);
  }
  const stale = operation([update(get('project'), { status: 'someday' })]);
  for (const status of ['completed', 'active', 'someday', 'active']) {
    const body = operation([update(get('project'), { status })]);
    const result = await post(server.url, body);
    assert.equal(result.status, 200);
    assert.deepEqual(await post(server.url, body), result, 'retry has exactly one receipt');
    const project = get('project');
    assert.equal(project.status, status);
    for (const field of ['id', 'title', 'outcome', 'description', 'originalText', 'createdUtc']) assert.equal(project[field], original[field]);
    assert.deepEqual(get('action'), action, 'unfinished linked action is untouched');
  }
  const latest = structuredClone(get('project'));
  assert.equal((await post(server.url, stale)).body.status, 'conflict');
  assert.deepEqual(get('project'), latest);
  assert.equal(get('project').version, original.version + 4);
});

test('undoing a project lifecycle edit restores its current status', () => {
  const record = { type: 'project', id: 'project', title: 'Project', outcome: 'Keep', workspaceId: 'personal', status: 'active', version: 1 };
  const state = { records: { 'project:project': record }, queue: [] };
  const fields = { status: 'completed' };
  enqueue(state, 'alice', [update(record, fields)]);
  rememberEdit(state, record, fields);
  undoEdit(state, 'alice', state.undoEdit.operationId);
  assert.equal(projected(state)['project:project'].status, 'active');
});

test('project lifecycle stays recoverable offline and separates active and someday reviews', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  assert.equal((await post(server.url, operation([
    create('project', 'legacy', { title: 'Legacy', outcome: 'Original outcome', description: 'Original notes' }),
    create('project', 'draft-review', { title: 'Needs outcome', status: 'draft' }),
    create('project', 'incubated', { title: 'Incubated', outcome: 'Future outcome', status: 'someday' }),
    create('project', 'finished', { title: 'Finished', outcome: 'Achieved outcome', status: 'completed' }),
    create('item', 'unfinished', { title: 'Unfinished action', status: 'next', projectId: 'legacy' }),
    create('item', 'done', { title: 'Done action', status: 'completed', projectId: 'legacy' })
  ]))).status, 200);
  const actions = structuredClone(records().filter(record => record.type === 'item'));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await clickControl(page.locator('#openReviews')); await page.locator('#startWeekly').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('0 of 3')); await confirmed(page);
  const weekly = structuredClone(records().find(record => record.reviewKind === 'weekly'));
  assert.deepEqual(weekly.included.map(ref => ref.id).sort(), ['draft-review', 'legacy', 'unfinished']);
  await page.locator('#startSomeday').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('someday review: 0 of 1')); await confirmed(page);
  assert.deepEqual(records().find(record => record.reviewKind === 'someday').included, [{ type: 'project', id: 'incubated' }]);
  await page.locator('#reviewEdit').click();
  await page.getByLabel('Project status', { exact: true }).selectOption('active');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' }); await confirmed(page);
  assert.equal(get('incubated').status, 'active');
  await page.locator('#reviewRetain').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('1 of 1')); await confirmed(page);
  const history = structuredClone(records().filter(record => ['review', 'reviewDecision'].includes(record.type)));

  await showView(page, 'work'); await page.locator('#view').selectOption('project:legacy');
  await page.getByRole('button', { name: 'Edit Unfinished action', exact: true }).click();
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Edit project: Legacy', exact: true }).click();
  assert.equal(await page.getByLabel('Project status', { exact: true }).inputValue(), 'active');
  assert.deepEqual(await page.locator('#projectStatus option').evaluateAll(options => options.map(option => option.value)), ['draft', 'active', 'someday', 'completed']);
  assert.match(await page.locator('#projectStatusHelp').textContent(), /linked actions keep their own statuses/i);
  await page.getByLabel('Project status', { exact: true }).selectOption('completed');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=4')).transact('alice')).draft.edit?.fields.projectStatus === 'completed');
  await page.reload(); await page.locator('#editor').waitFor();
  assert.equal(await page.getByLabel('Project status', { exact: true }).inputValue(), 'completed');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=4')).transact('alice')).queue.some(entry => entry.operation.mutations.some(m => m.id === 'legacy' && m.fields?.status === 'completed')));
  const queued = await page.evaluate(async () => (await (await import('/inbox-store.js?v=4')).transact('alice')).queue);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.match(await page.locator('#projectOutcome').textContent(), /Project status: completed/);
  assert.deepEqual(await page.evaluate(async () => (await (await import('/inbox-store.js?v=4')).transact('alice')).queue), queued);
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', includeHidden: true })); await confirmed(page);
  assert.equal(get('legacy').status, 'completed');
  assert.deepEqual(records().filter(record => record.type === 'item'), actions);
  assert.deepEqual(records().filter(record => ['review', 'reviewDecision'].includes(record.type)), history);
  await clickControl(page.locator('#openReviews')); await page.locator('#startWeekly').click();
  await page.waitForFunction(() => document.querySelector('#reviewProgress').textContent.includes('weekly review: 0 of 3')); await confirmed(page);
  assert.deepEqual(records().filter(record => record.reviewKind === 'weekly').at(-1).included.map(ref => ref.id).sort(), ['draft-review', 'incubated', 'unfinished']);

  await showView(page, 'work'); await page.locator('#view').selectOption('project:legacy');
  await page.getByRole('button', { name: 'Edit project: Legacy', exact: true }).click();
  await page.getByLabel('Project status', { exact: true }).selectOption('someday');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' }); await confirmed(page);
  assert.equal(get('legacy').status, 'someday');
  await page.getByRole('button', { name: 'Edit project: Legacy', exact: true }).click();
  await page.getByLabel('Project status', { exact: true }).selectOption('active');
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' }); await confirmed(page);
  assert.equal(get('legacy').status, 'active');
  assert.equal(get('legacy').outcome, 'Original outcome'); assert.equal(get('legacy').description, 'Original notes');
  await page.locator('#view').selectOption('project:finished');
  assert.match(await page.locator('#projectOutcome').textContent(), /Achieved outcome/);
  assert.match(await page.locator('#view option:checked').textContent(), /Completed/);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no overflow at ${width}`);
  }
  assert.deepEqual(errors, []);
});
