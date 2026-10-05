import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl } from './navigation-helper.mjs';

const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

for (const [timezoneId, instant] of [
  ['America/Regina', '2026-10-03T15:00:00Z'],
  ['Asia/Tokyo', '2026-10-02T15:30:00Z'],
  ['America/New_York', '2026-03-08T05:30:00Z'], // 23-hour spring day
  ['America/New_York', '2026-11-01T04:30:00Z'], // 25-hour fall day
]) {
  test(`daily review includes the whole local deadline day: ${timezoneId} ${instant}`, async t => {
    documents.length = 0;
    const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
    const context = await browser.newContext({ timezoneId });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(instant));
    const { day, mutations } = await page.evaluate(() => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const date = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
      const day = date(now), tomorrowDay = date(tomorrow);
      const later = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17).toISOString();
      const yesterday = new Date(midnight.getTime() - 1).toISOString();
      const cases = {
        overdue: { dueDateUtc: yesterday },
        midnight: { dueDateUtc: midnight.toISOString() },
        now: { dueDateUtc: now.toISOString() },
        later: { dueDateUtc: later },
        'last-millisecond': { dueDateUtc: new Date(tomorrow.getTime() - 1).toISOString() },
        tomorrow: { dueDateUtc: tomorrow.toISOString() },
        'next-tomorrow': { status: 'next', dueDateUtc: tomorrow.toISOString() },
        'planned-tomorrow': { plannedDay: day, dueDateUtc: tomorrow.toISOString() },
        completed: { status: 'completed', dueDateUtc: later },
        dropped: { status: 'dropped', dueDateUtc: yesterday },
        'reference-later': { status: 'reference', dueDateUtc: later, plannedDay: day },
        'reference-overdue': { status: 'reference', dueDateUtc: yesterday },
        deleted: { dueDateUtc: later },
        'waiting-later': { status: 'waiting', waitingOn: 'Supplier', reviewDateUtc: later },
        'deferred-later': { status: 'deferred', startDateUtc: later },
        'waiting-ready': { status: 'waiting', waitingOn: 'Supplier', reviewDateUtc: now.toISOString() },
        'deferred-ready': { status: 'deferred', startDateUtc: now.toISOString() },
        'waiting-deadline': { status: 'waiting', waitingOn: 'Supplier', reviewDateUtc: later, dueDateUtc: later },
        'calendar-today': { dueDate: day },
        'calendar-overdue': { dueDate: date(new Date(midnight.getTime() - 1)) },
        'calendar-tomorrow': { dueDate: tomorrowDay },
        undated: {},
      };
      return { day, mutations: Object.entries(cases).map(([id, fields]) => ({ type: 'item', id, action: 'create', expectedVersion: 0,
        fields: { title: id, originalText: id, workspaceId: 'personal', collectionRefs: [], status: 'scheduled', ...fields } })) };
    });
    const post = async mutations => {
      const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
        body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations }) });
      assert.equal(response.status, 200, await response.text());
    };
    for (let start = 0; start < mutations.length; start += 20) await post(mutations.slice(start, start + 20));
    await post([{ type: 'item', id: 'deleted', action: 'delete', expectedVersion: 1 }]);
    await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
    await clickControl(page.locator('#openReviews')); await page.locator('#startDaily').click();
    await page.waitForFunction(() => !document.querySelector('#reviewBody').hidden); await confirmed(page);
    const session = documents.find(doc => doc.kind === 'record' && doc.record.type === 'review').record;
    assert.equal(session.reviewDay, day);
    assert.deepEqual(session.included.map(ref => ref.id).sort(), [
      'overdue', 'midnight', 'now', 'later', 'last-millisecond', 'next-tomorrow', 'planned-tomorrow',
      'waiting-ready', 'deferred-ready', 'waiting-deadline', 'calendar-today', 'calendar-overdue',
    ].sort());
    assert.equal(documents.find(doc => doc.kind === 'record' && doc.record.id === 'later').record.plannedDay, null);
    await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
    await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor();
    await clickControl(page.locator('#openReviews'));
    await page.locator('#reviewSessions').selectOption(session.id);
    assert.equal(await page.locator('#reviewRecord option').count(), session.included.length, 'the frozen review can resume offline');
  });
}
