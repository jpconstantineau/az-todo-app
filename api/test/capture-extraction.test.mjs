import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueFields, parseExtraction, extractionMutations } from '../../html/capture-extraction.js';
import { fieldsFor } from '../api/v1/contract.mjs';
import { enqueue } from '../../html/inbox-store.js';

const source = { id: 'capture-a', text: 'Call Sam tomorrow at 3 pm. Buy milk today.', notes: 'Keep the receipt.', capturedUtc: '2026-10-04T03:00:00.000Z', timeZone: 'America/Regina' };
const suggestion = { title: 'Call Sam', description: '', dateText: 'tomorrow', timeText: '3 pm', listId: '', priority: '', contexts: [], areas: [], uncertainty: '' };

test('capture dates use the captured local day, keep date-only semantics and reject ambiguous timezones/DST', () => {
  assert.deepEqual(dueFields('tomorrow', '3 pm', source), { dueDate: null, dueDateUtc: '2026-10-04T21:00:00.000Z', warning: '' });
  assert.equal(dueFields('today', '', source).dueDate, '2026-10-03');
  assert.ok(dueFields('next Friday', '', source).warning);
  assert.ok(dueFields('tomorrow', '3', source).warning);
  for (const text of ['2026-11-01 1:30 am', '2026-03-08 2:30 am']) {
    const [date, ...time] = text.split(' ');
    assert.ok(dueFields(date, time.join(' '), { ...source, text, timeZone: 'America/New_York' }).warning);
  }
  assert.ok(dueFields('2026-02-30', '', { ...source, text: '2026-02-30' }).warning);
});

test('structured extraction rejects malformed/extra/oversized fields and never grants unknown list access', () => {
  const parse = item => parseExtraction(JSON.stringify({ items: [item] }), source);
  for (const raw of ['null', '[]', '{}', 'not json', JSON.stringify({ items: [suggestion], accountId: 'bob' }), JSON.stringify({ items: Array(21).fill(suggestion) }), 'a'.repeat(64001)]) assert.throws(() => parseExtraction(raw, source));
  for (const item of [{ ...suggestion, title: ' ' }, { ...suggestion, title: 'a'.repeat(201) }, { ...suggestion, contexts: 'work' }, { ...suggestion, status: 'done' }]) assert.throws(() => parse(item));
  const [item] = parse({ ...suggestion, listId: 'foreign-list' });
  assert.equal(item.listId, ''); assert.match(item.warning, /Unknown destination/);
  assert.equal(parseExtraction('{"items":[]}', source).length, 0);
});

test('reviewed tasks retain shared immutable capture metadata through server validation', () => {
  const items = parseExtraction(JSON.stringify({ items: [suggestion, { ...suggestion, title: 'Buy milk', dateText: 'today', timeText: '' }] }), source);
  const mutations = extractionMutations({ ...source, items }, {});
  assert.notEqual(mutations[0].id, mutations[1].id);
  for (const mutation of mutations) {
    const fields = fieldsFor('item', 'create', mutation.fields);
    assert.deepEqual(fields.capture, { id: source.id, capturedUtc: source.capturedUtc, timeZone: source.timeZone, notes: source.notes });
    assert.equal(fields.originalText, source.text);
    assert.throws(() => fieldsFor('item', 'update', { capture: fields.capture }));
    for (const change of [{ timeZone: 'invalid' }, { capturedUtc: '2026-02-30T00:00:00.000Z' }, { id: '../bad' }, { accountId: 'bob' }, { notes: 'a'.repeat(4001) }]) assert.throws(() => fieldsFor('item', 'create', { ...mutation.fields, capture: { ...fields.capture, ...change } }));
  }
});

test('review validation and operation size fail atomically without dropping the draft', () => {
  const [item] = parseExtraction(JSON.stringify({ items: [suggestion] }), source);
  for (const changes of [{ dueDate: '2026-02-30' }, { dueDate: '2026-10-03' }, { listId: 'deleted' }, { contexts: ['a'.repeat(65)] }, { dueDateUtc: '2026-02-30T15:00:00Z' }]) assert.throws(() => extractionMutations({ ...source, items: [{ ...item, ...changes }] }, {}));
  const draft = { ...source, text: 'a'.repeat(16000), items: Array.from({ length: 5 }, (_, i) => ({ ...item, id: 'item-' + i })) };
  const state = { records: {}, queue: [], draft: { extraction: draft } };
  assert.throws(() => enqueue(state, 'alice', extractionMutations(draft, {})), /too large/);
  assert.equal(state.queue.length, 0); assert.equal(state.draft.extraction.text.length, 16000);
});
