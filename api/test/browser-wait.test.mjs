import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForBrowser } from './browser-wait.mjs';

test('browser wait retries resolved false values and passes the predicate argument', async () => {
  let calls = 0;
  const page = { evaluate: (predicate, arg) => predicate(arg) };
  await waitForBrowser(page, async target => ++calls === target, 3);
  assert.equal(calls, 3);
});

test('browser wait fails on timeout or evaluation errors instead of reporting success', async () => {
  const page = { evaluate: (predicate, arg) => predicate(arg) };
  await assert.rejects(waitForBrowser(page, async () => false, undefined, 0), /Timed out waiting/);
  await assert.rejects(waitForBrowser(page, async () => { throw new Error('Evaluation failed'); }), /Evaluation failed/);
});
