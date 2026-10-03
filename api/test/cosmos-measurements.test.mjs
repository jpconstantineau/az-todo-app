import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents } from './harness.mjs';
import { measureStore, measurementScenarios, summarize, workloadOperation } from '../scripts/cosmos-measurements.mjs';
import { bytes, MAX_RECORD_BYTES } from '../api/v1/contract.mjs';
const store = await import('../api/v1/store.mjs');
const { container } = await import('../api/shared/db.mjs');

test('measurement attributes interleaved SDK charges, batch retries and errors without recording private values', async () => {
  const fake = {
    item(id) { return { async read() {
      await new Promise(resolve => setImmediate(resolve));
      if (id === 'missing') throw Object.assign(new Error('private task/token'), { code: 404, headers: { 'x-ms-request-charge': '1.5', authorization: 'secret' } });
      return { requestCharge: 2, resource: { private: 'task' } };
    } }; },
    items: { async batch() { return { requestCharge: 4, code: 207, result: [{ statusCode: 412 }, { statusCode: 424 }, { statusCode: 412 }] }; } }
  };
  const originalItem = fake.item, originalBatch = fake.items.batch;
  const meter = measureStore(fake);
  try {
    await Promise.all([
      meter.run('one', async () => {
        await fake.item('found').read(); await fake.items.batch(); await fake.items.batch();
        return { status: 'committed' };
      }),
      meter.run('two', async () => {
        await assert.rejects(fake.item('missing').read(), { code: 404 });
        return { entries: [] };
      })
    ]);
    assert.equal(meter.samples[0].requestCharge, 10);
    assert.deepEqual(meter.samples[0].knownChargeByKind, { pointReads: 2, batchAttempts: 8 });
    assert.equal(meter.samples[0].batchAttempts, 2);
    assert.equal(meter.samples[0].sdkStatuses[412], 2, 'do not count each failed suboperation as a retry');
    assert.equal(meter.samples[1].requestCharge, 1.5);
    assert.equal(meter.samples[1].pointReads, 1);
    assert.doesNotMatch(JSON.stringify(meter.samples), /private|token|secret/);
  } finally { meter.restore(); }
  assert.equal(fake.item, originalItem); assert.equal(fake.items.batch, originalBatch);
});

test('missing charges stay unknown, surfaced throttles and account_busy remain distinct, and percentiles use nearest rank', async () => {
  const fake = {
    item() { return { async read() { return Object.create({ get requestCharge() { return 0; } }); } }; },
    items: { async batch() { throw Object.assign(new Error('private'), { code: 429, requestCharge: 3 }); } }
  };
  const meter = measureStore(fake);
  try {
    await meter.run('read', async () => { await fake.item().read(); return {}; });
    await assert.rejects(meter.run('write', () => fake.items.batch()), { code: 429 });
    await assert.rejects(meter.run('write', async () => { throw Object.assign(new Error(), { code: 'account_busy', status: 503 }); }));
    assert.equal(meter.samples[0].requestCharge, null);
    assert.equal(meter.samples[1].sdkStatuses[429], 1);
    assert.equal(meter.samples[2].httpStatus, 503);
    assert.equal(meter.samples[2].sdkStatuses[503], 0);
    meter.samples.forEach((sample, i) => { sample.durationMs = i + 1; });
    const summary = summarize(meter.samples);
    assert.equal(summary[0].requestCharge, null);
    assert.equal(summary[0].knownRequestCharge, 0);
    assert.deepEqual(summary[1].durationMs, { p50: 2, p95: 3, p99: 3 });
    assert.equal(summary[1].outcomes.account_busy, 1);
    assert.equal(summary[1].outcomes.failed, 1);
    assert.deepEqual(summarize([]), []);
  } finally { meter.restore(); }
});

test('small and near-limit workloads execute production writes, repeat-safe retries and bounded catch-up for 1/2/8 callers', async () => {
  const originalItem = container.item, originalBatch = container.items.batch;
  const report = {}, snapshots = [];
  await measurementScenarios({ store, container, report, records: 20, editRounds: 1,
    check: async (_name, action) => { documents.length = 0; await action(); },
    checkpoint: async () => snapshots.push(structuredClone(report)) });
  assert.equal(report.measurements.length, 6);
  assert.equal(snapshots.length, 6);
  for (const row of report.measurements) {
    assert.equal(row.status, 'PASS');
    assert.deepEqual(row.pages.map(p => p.through), [20, 40, 40]);
    assert.equal(row.summaries.find(s => s.phase === 'receipt-replay').batchAttempts, 0);
    assert.ok(row.summaries.every(s => s.requestCharge === null), 'mock lacks RU evidence');
    if (row.size === 'near-limit') {
      assert.ok(row.pages.find(p => p.phase === 'full-history-catch-up').pages > 1);
      const record = documents.find(d => d.kind === 'record').record;
      assert.ok(bytes(record) > 30000 && bytes(record) < MAX_RECORD_BYTES);
    }
    if (row.concurrency === 8) assert.ok(row.summaries.some(s => s.outcomes.account_busy > 0));
  }
  assert.equal(container.item, originalItem); assert.equal(container.items.batch, originalBatch);
  assert.equal(workloadOperation('test', 'near-limit', 0, 0).mutations[0].fields.originalText.length, 16000);
});

test('failed measurement checkpoints partial evidence and restores SDK methods after every writer settles', async () => {
  const originalItem = container.item, originalBatch = container.items.batch;
  const report = {}, snapshots = [];
  await assert.rejects(measurementScenarios({ store: { async commit() { throw new Error('secret endpoint'); } }, container, report,
    check: async (_name, action) => action(), checkpoint: async () => snapshots.push(structuredClone(report)) }));
  assert.equal(report.measurements[0].status, 'FAIL');
  assert.equal(report.measurements[0].summaries[0].outcomes.failed, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(container.item, originalItem); assert.equal(container.items.batch, originalBatch);
  assert.doesNotMatch(JSON.stringify(report), /secret|endpoint/);
});
