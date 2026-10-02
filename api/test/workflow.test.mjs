import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { taskFields, reviewReady } from '../../html/inbox-fields.js';
import { enqueue, projected } from '../../html/inbox-store.js';

test('workflow API: atomic validation, waiting/deferred, completion, undo and stale transitions', async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  let record;
  async function save(fields, expectedVersion = record?.version || 0) {
    const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
        { type: 'item', id: 'action', action: expectedVersion ? 'update' : 'create', expectedVersion, fields }
      ] }) });
    const body = await response.json();
    if (response.status === 200) record = body.records[0];
    return { status: response.status, body };
  }
  assert.equal((await save({ title: 'Get approval', status: 'waiting' })).status, 400);
  assert.equal(documents.length, 0, 'invalid capture commits neither record nor receipt');
  assert.equal((await save({ title: 'Get approval', status: 'next', dueDate: '2026-11-02' })).status, 200);
  assert.equal(record.nextAction, true);
  assert.equal((await save({ status: 'waiting', waitingOn: 'Alex' })).status, 400);
  assert.equal((await save({ status: 'waiting', waitingOn: 'Alex', reviewDate: '2026-10-05' })).status, 200);
  const waiting = structuredClone(record);
  assert.equal(record.nextAction, false);
  assert.equal((await save({ status: 'completed' })).status, 200);
  assert.equal(record.statusBeforeCompletion, 'waiting');
  assert.equal(record.waitingOn, 'Alex');
  assert.ok(record.completedUtc);
  await save({ status: 'deferred', startDate: '2026-10-10' });
  await save(record.workflowBeforeTransition);
  assert.equal(record.status, 'completed'); assert.equal(record.statusBeforeCompletion, 'waiting');
  assert.equal((await save({ status: record.statusBeforeCompletion })).status, 200);
  assert.equal(record.status, 'waiting'); assert.equal(record.completedUtc, null);
  assert.equal(record.reviewDate, waiting.reviewDate);
  assert.equal((await save({ status: 'deferred' })).status, 400);
  assert.equal((await save({ status: 'deferred', startDate: '2026-10-10' })).status, 200);
  assert.equal(record.dueDate, '2026-11-02', 'deferral never moves the deadline');
  assert.equal((await save(record.workflowBeforeTransition)).status, 200);
  assert.equal(record.status, 'waiting'); assert.equal(record.startDate, null);
  assert.equal(record.waitingOn, 'Alex'); assert.equal(record.reviewDate, waiting.reviewDate);
  assert.equal((await save({ status: 'next' }, waiting.version)).status, 409);
  assert.equal((await save({ reviewDate: '2026-02-30' })).status, 400);
  assert.equal((await save({ reviewDateUtc: '2026-11-01T01:30:00' })).status, 400);
  assert.equal((await save({ reviewDateUtc: '2026-11-01T06:30:00.000Z' })).status, 400, 'one date representation at a time');
  assert.equal((await save({ reviewDate: null, reviewDateUtc: '2026-11-01T06:30:00.000Z' })).status, 200);
  assert.equal((await save({ nextAction: true })).status, 400, 'nextAction is derived, never client-writable');
  // Existing custom status/date values survive ordinary edits and completion/reopening.
  const stored = documents.find(doc => doc.id === 'record:item:action').record;
  stored.status = 'historic'; stored.startDateUtc = 'old date text';
  assert.equal((await save({ description: 'Keep legacy fields' })).status, 200);
  assert.equal(record.status, 'historic'); assert.equal(record.startDateUtc, 'old date text');
  assert.equal((await save({ status: 'deferred' })).status, 400, 'a required inherited cue must be valid');
  await save({ status: 'completed' }); await save({ status: record.statusBeforeCompletion });
  assert.equal(record.status, 'historic'); assert.equal(record.nextAction, false);
});

test('workflow projection validates before journaling and preserves offline undo metadata', () => {
  const state = { records: { 'item:a': { type: 'item', id: 'a', version: 1, status: 'next', nextAction: true, dueDate: '2026-10-20' } }, queue: [] };
  const save = fields => enqueue(state, 'alice', [{ type: 'item', id: 'a', action: 'update', expectedVersion: projected(state)['item:a'].version, fields }]);
  assert.throws(() => save({ status: 'waiting' }), /Waiting needs/); assert.equal(state.queue.length, 0);
  save({ status: 'waiting', waitingOn: 'Permit', reviewDate: '2026-10-03' });
  assert.equal(projected(state)['item:a'].nextAction, false);
  save({ status: 'completed' });
  assert.equal(projected(state)['item:a'].statusBeforeCompletion, 'waiting');
  save({ status: 'deferred', startDate: '2026-10-10' });
  save(projected(state)['item:a'].workflowBeforeTransition);
  assert.equal(projected(state)['item:a'].statusBeforeCompletion, 'waiting');
  save({ status: 'waiting' });
  save({ status: 'deferred', startDate: '2026-10-10' });
  save(projected(state)['item:a'].workflowBeforeTransition);
  const item = projected(state)['item:a'];
  assert.equal(item.status, 'waiting'); assert.equal(item.waitingOn, 'Permit');
  assert.equal(item.startDate, null); assert.equal(item.dueDate, '2026-10-20');
});

test('calendar dates, explicit DST offsets, ready-for-review rules and unchanged historic dates', () => {
  assert.equal(taskFields({ dueDate: '2026-11-01' }).dueDate, '2026-11-01');
  assert.throws(() => taskFields({ startDate: '2026-02-30' }), /calendar date/);
  assert.throws(() => taskFields({ reviewDateUtc: '2026-11-01T01:30:00' }), /explicit offset/);
  assert.equal(taskFields({ reviewDateUtc: '2026-11-01T01:30:00-04:00' }).reviewDateUtc, '2026-11-01T05:30:00.000Z');
  assert.equal(taskFields({ reviewDateUtc: '2026-11-01T01:30:00-05:00' }).reviewDateUtc, '2026-11-01T06:30:00.000Z');
  assert.throws(() => taskFields({ reviewDateUtc: '2026-02-30T01:30:00Z' }), /ISO time/);
  const initial = { status: 'custom', startDateUtc: 'historic invalid date', dueLocal: '2026-11-01T01:30' };
  const patch = taskFields({ ...initial, title: 'Edited' }, initial);
  assert.equal('startDateUtc' in patch, false); assert.equal('dueDateUtc' in patch, false);
  const now = new Date(2026, 9, 5, 0, 0);
  assert.equal(reviewReady({ status: 'deferred', startDate: '2026-10-05' }, now), true);
  assert.equal(reviewReady({ status: 'deferred', startDate: '2026-10-06' }, now), false);
  assert.equal(reviewReady({ status: 'waiting', reviewDateUtc: now.toISOString() }, now), true);
  assert.equal(reviewReady({ status: 'completed', reviewDate: '2026-10-01' }, now), false);
});

test('workflow browser: actionable validation, offline reload/reopen/undo and calendar dates across zones', { timeout: 60000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ timezoneId: 'America/New_York', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const confirmed = () => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.locator('#captureText').fill('Get approval');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#captureText').value); await confirmed();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Edit Get approval', exact: true }).click();
  await page.locator('#editAdvanced summary').click();
  await page.locator('#edit [name=status]').selectOption('waiting');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.waitForFunction(() => !document.querySelector('#editError').hidden);
  assert.match(await page.locator('#editError').innerText(), /Waiting needs/);
  assert.equal(await page.locator('#editor').isVisible(), true);
  await page.locator('#edit [name=waitingOn]').fill('Alex');
  await page.locator('#edit [name=reviewDate]').fill('2020-01-01');
  await page.locator('#edit [name=dueDate]').fill('2026-11-01');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#edit [name=status]').evaluate(input => input.parentElement.scrollIntoView({ block: 'start' }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'workflow controls fit the viewport');
    if (process.env.WORKFLOW_SCREENSHOTS) {
      await mkdir(process.env.WORKFLOW_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.WORKFLOW_SCREENSHOTS}/workflow-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Save edit on device' }).click(); await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Complete Get approval', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen Get approval', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: 'Complete Get approval', exact: true }).waitFor();
  assert.match(await page.locator('#items').innerText(), /Waiting for: Alex/);
  await page.getByRole('button', { name: 'Edit Get approval', exact: true }).click();
  if (!await page.locator('#editAdvanced').getAttribute('open')) await page.locator('#editAdvanced summary').click();
  await page.locator('#edit [name=status]').selectOption('deferred');
  await page.locator('#edit [name=startDate]').fill('2020-01-02');
  await page.getByRole('button', { name: 'Save edit on device' }).click(); await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.locator('#statusFilter').selectOption('@review-ready');
  assert.equal(await page.locator('#items article').count(), 1);
  await page.getByRole('button', { name: 'Undo state change Get approval', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#items').textContent.includes('waiting ·'));
  await context.setOffline(false); await page.getByRole('button', { name: 'Sync now' }).click(); await confirmed();
  const saved = documents.find(doc => doc.id.startsWith('record:item:')).record;
  assert.equal(saved.status, 'waiting'); assert.equal(saved.nextAction, false);
  assert.equal(saved.waitingOn, 'Alex'); assert.equal(saved.dueDate, '2026-11-01'); assert.equal(saved.startDate, null);
  for (const timezoneId of ['Pacific/Honolulu', 'Pacific/Auckland']) {
    const other = await browser.newContext({ timezoneId }); const tab = await other.newPage();
    await tab.goto(server.url); await tab.getByRole('button', { name: 'Edit Get approval', exact: true }).click();
    assert.equal(await tab.locator('#edit [name=dueDate]').inputValue(), '2026-11-01');
    await other.close();
  }
  // Spring-forward gaps are rejected instead of silently shifting the deadline.
  const gap = await page.evaluate(async () => {
    try { (await import('/inbox-fields.js')).taskFields({ dueLocal: '2026-03-08T02:30' }); return ''; }
    catch (error) { return error.message; }
  });
  assert.match(gap, /valid local due date/);
  assert.deepEqual(errors, []);
});
