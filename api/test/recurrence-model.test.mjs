import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../api/v1/recurrence-model.mjs';
import * as client from '../../html/recurrence-model.js';
import { validateOperation } from '../api/v1/contract.mjs';
import { deviceExport, readableExport, validateDeviceExport } from '../../html/inbox-export.js';

const fixed = (unit, interval = 1, anchorDate = '2024-01-31', timeZone = 'America/Regina') => ({ mode: 'fixed', unit, interval, anchorDate, timeZone });

test('recurrence calendar arithmetic is anchor-relative, leap-safe and bounded across large jumps', () => {
  assert.equal(server.fixedDate(fixed('day', 2, '2024-02-27'), 3), '2024-03-02');
  assert.equal(server.fixedDate(fixed('week', 2, '2024-01-01'), 3), '2024-01-29');
  assert.equal(server.fixedDate(fixed('month'), 2), '2024-02-29');
  assert.equal(server.fixedDate(fixed('month'), 3), '2024-03-31');
  assert.equal(server.fixedDate(fixed('month', 1, '2023-01-31'), 2), '2023-02-28');
  assert.equal(server.latestFixedDate(fixed('day', 1, '0001-01-01'), '9999-12-31'), '9999-12-31');
});

test('date-only eligibility observes saved DST and non-DST zones without 24-hour arithmetic', () => {
  assert.equal(server.zonedDate('2026-03-08T04:59:59Z', 'America/New_York'), '2026-03-07');
  assert.equal(server.zonedDate('2026-03-08T05:00:00Z', 'America/New_York'), '2026-03-08');
  assert.equal(server.zonedDate('2026-11-01T04:00:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(server.zonedDate('2026-03-08T05:59:59Z', 'America/Regina'), '2026-03-07');
  assert.equal(server.zonedDate('2026-03-08T06:00:00Z', 'America/Regina'), '2026-03-08');
  assert.equal(server.nextAfterResolution({ ...fixed('day'), mode: 'after-resolution' }, '2026-03-08T07:30:00Z'), '2026-03-09');
});

test('fixed missed slots coalesce, after-resolution retains its calculated date and open work never duplicates', () => {
  const base = { id: 'rent', version: 4, paused: false, tombstoned: false, openOccurrenceId: null, nextOccurrenceNumber: 3,
    nextIntendedDate: '2026-01-01', rule: fixed('month', 1, '2026-01-01') };
  assert.equal(server.materializationDate(base, new Date('2026-10-07T18:00:00Z')), '2026-10-01');
  assert.equal(server.materializationDate({ ...base, rule: { ...base.rule, mode: 'after-resolution' } }, new Date('2026-10-07T18:00:00Z')), '2026-01-01');
  assert.equal(server.materializationDate({ ...base, openOccurrenceId: 'open' }, new Date('2026-10-07T18:00:00Z')), null);
});

test('client and server recurrence identity and calendar helpers stay output-compatible', () => {
  const rules = [fixed('day', 3, '2026-10-07', 'America/New_York'), fixed('week', 2), fixed('month')];
  for (const rule of rules) for (const number of [1, 2, 12, 4096]) {
    assert.equal(client.occurrenceId('Template_123', number), server.occurrenceId('Template_123', number));
    assert.equal(client.fixedDate(rule, number), server.fixedDate(rule, number));
  }
});

test('contract validates template rules and exact derived occurrence identities', () => {
  const template = { title: 'Pay rent', description: '', workspaceId: 'personal', collectionRefs: [], listId: null, projectId: null, status: 'inbox', contexts: [], areas: [], energy: null, timeRequired: null, priority: null, referenceLinks: [], rule: fixed('month'), paused: false, tombstoned: false, nextOccurrenceNumber: 1, nextIntendedDate: '2024-01-31', openOccurrenceId: null, lastResolvedUtc: null };
  assert.equal(validateOperation({ apiVersion: 1, accountId: 'alice', operationId: 'template-create', mutations: [{ type: 'recurrenceTemplate', id: 'rent', action: 'create', expectedVersion: 0, fields: template }] }).mutations[0].fields.rule.timeZone, 'America/Regina');
  assert.throws(() => validateOperation({ apiVersion: 1, accountId: 'alice', operationId: 'bad-zone', mutations: [{ type: 'recurrenceTemplate', id: 'rent', action: 'create', expectedVersion: 0, fields: { ...template, rule: { ...template.rule, timeZone: 'Mars/Olympus' } } }] }), /timezone/);
  const occurrence = { ...client.recurrenceSnapshot(template), recurrenceTemplateId: 'rent', recurrenceNumber: 1, intendedDate: '2024-01-31', sourceTemplateVersion: 1, occurrenceState: 'open', occurrenceResolvedUtc: null };
  assert.throws(() => validateOperation({ apiVersion: 1, accountId: 'alice', operationId: 'forged', mutations: [{ type: 'item', id: 'forged', action: 'create', expectedVersion: 0, fields: occurrence }] }), /identity/);
});

test('device and readable exports preserve recurrence rule, tombstone/history and recurrence drafts', () => {
  const now = '2026-10-07T18:00:00.000Z', id = client.occurrenceId('rent', 1);
  const template = { ...templateRecord(), id: 'rent', type: 'recurrenceTemplate', accountId: 'alice', version: 2, createdUtc: now, updatedUtc: now, deleted: false, deletedUtc: null, tombstoned: true, paused: true, openOccurrenceId: id, nextOccurrenceNumber: 2 };
  const item = { ...client.recurrenceSnapshot(template), id, type: 'item', accountId: 'alice', version: 1, createdUtc: now, updatedUtc: now, deleted: false, deletedUtc: null,
    status: 'inbox', recurrenceTemplateId: 'rent', recurrenceNumber: 1, intendedDate: template.nextIntendedDate, sourceTemplateVersion: 1, occurrenceState: 'open', occurrenceResolvedUtc: null };
  const value = deviceExport('alice', { records: { 'recurrenceTemplate:rent': template, [`item:${id}`]: item }, queue: [], after: 2, draft: { recurrence: { editing: { id: 'rent', version: 2 }, values: { title: 'Edited rent' }, open: false } } }, { recurrence: { values: { title: 'Edited rent' } } });
  assert.deepEqual(validateDeviceExport(value).warnings, []);
  assert.match(readableExport(value), /RECURRING TEMPLATES[\s\S]*Pay rent[\s\S]*OCCURRENCE HISTORY[\s\S]*intended 2024-01-31/);
});

function templateRecord() {
  return { title: 'Pay rent', description: '', workspaceId: 'personal', collectionRefs: [], listId: null, projectId: null, status: 'inbox', contexts: [], areas: [], energy: null, timeRequired: null, priority: null, referenceLinks: [], rule: fixed('month'), paused: false, tombstoned: false, nextOccurrenceNumber: 1, nextIntendedDate: '2024-01-31', openOccurrenceId: null, lastResolvedUtc: null };
}
