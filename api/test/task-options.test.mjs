import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsFromText } from '../../html/inbox-fields.js';

test('task option text trims and deduplicates before enforcing the unique limit', () => {
  assert.deepEqual(optionsFromText('contexts', ' Home \nWork\nHome\n\nWork'), ['Home', 'Work']);
  assert.equal(optionsFromText('contexts', Array(201).fill('same').join('\n')).length, 1);
  assert.equal(optionsFromText('contexts', Array.from({ length: 200 }, (_, index) => `value-${index}`).join('\n')).length, 200);
  assert.throws(() => optionsFromText('contexts', Array.from({ length: 201 }, (_, index) => `value-${index}`).join('\n')), /200 unique/);
  assert.throws(() => optionsFromText('contexts', 'x'.repeat(65)), /64 characters/);
  assert.throws(() => optionsFromText('contexts', 'valid\u0007invalid'), /64 characters/);
});
