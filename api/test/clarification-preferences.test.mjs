import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clarificationActionDefaults, clearClarificationDraft, insertClarificationAction, readClarificationActions, readClarificationDraft, validateClarificationActions, writeClarificationActions, writeClarificationDraft } from '../../html/clarification-preferences.js';

const memory = initial => ({
  value: initial,
  getItem() { return this.value ?? null; },
  setItem(_key, value) { this.value = value; },
  removeItem() { this.value = null; }
});

test('section positions move actions atomically without changing their stable IDs', () => {
  const actions = clarificationActionDefaults();
  const moved = insertClarificationAction(actions, { ...actions[7], placement: 'primary', label: 'Family role' }, 2);
  assert.deepEqual(moved.filter(entry => entry.placement === 'primary').map(entry => entry.id),
    ['project', 'role', 'list', 'checklist', 'action', 'reference', 'someday']);
  assert.equal(moved.find(entry => entry.id === 'role').label, 'Family role');
  assert.equal(new Set(moved.map(entry => entry.id)).size, moved.length);
});

test('unfinished Clarify action drafts use versioned session values and can be discarded', () => {
  const storage = memory();
  const values = { label: 'Shopping', behavior: 'make-checklist', placement: 'more', position: 2 };
  writeClarificationDraft('add', values, storage);
  assert.deepEqual(readClarificationDraft('add', storage), values);
  storage.value = JSON.stringify({ version: 2, values });
  assert.equal(readClarificationDraft('add', storage), null);
  writeClarificationDraft('add', values, storage); clearClarificationDraft('add', storage);
  assert.equal(readClarificationDraft('add', storage), null);
});

test('clarification action preferences use the balanced requested defaults', () => {
  const actions = clarificationActionDefaults();
  assert.deepEqual(actions.filter(entry => entry.placement === 'primary').map(entry => entry.label),
    ['Make project', 'Make list', 'Make checklist', 'Action', 'Reference', 'Someday']);
  assert.deepEqual(actions.filter(entry => entry.placement === 'more').map(entry => entry.label),
    ['Make area', 'Make role', 'Make initiative', 'Make program', 'Make reusable reference', 'Move to Deleted']);
});

test('clarification action preferences round-trip custom aliases and reject the whole malformed value', () => {
  const storage = memory(), actions = clarificationActionDefaults();
  actions.unshift({ id: 'custom-shopping', label: '  Make shopping list  ', behavior: 'make-checklist', placement: 'primary' });
  assert.equal(writeClarificationActions(actions, storage)[0].label, 'Make shopping list');
  assert.equal(readClarificationActions(storage)[0].behavior, 'make-checklist');
  storage.value = JSON.stringify({ version: 1, actions: [{ id: 'bad', label: '', behavior: 'make-list', placement: 'primary' }] });
  assert.deepEqual(readClarificationActions(storage), clarificationActionDefaults());
  assert.throws(() => validateClarificationActions([{ id: 'same', label: 'One', behavior: 'action', placement: 'primary' },
    { id: 'same', label: 'Two', behavior: 'someday', placement: 'more' }]), /unique ID/);
  assert.throws(() => validateClarificationActions(Array.from({ length: 33 }, (_, i) => ({ id: `a-${i}`, label: `Action ${i}`, behavior: 'action', placement: 'primary' }))), /at most 32/);
});
