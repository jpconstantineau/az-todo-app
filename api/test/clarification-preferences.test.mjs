import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clarificationActionDefaults, readClarificationActions, validateClarificationActions, writeClarificationActions } from '../../html/clarification-preferences.js';

const memory = initial => ({
  value: initial,
  getItem() { return this.value ?? null; },
  setItem(_key, value) { this.value = value; }
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
