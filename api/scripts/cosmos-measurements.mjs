import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bytes, validateOperation } from '../api/v1/contract.mjs';

const percentiles = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, sorted.length ? sorted[Math.ceil(sorted.length * p / 100) - 1] : null]));
};

// Instrument only this standalone runner's SDK handles, never production routes.
// AsyncLocalStorage keeps concurrent calls' costs attached to the right sample.
export function measureStore(container) {
  const context = new AsyncLocalStorage();
  const originalItem = container.item, originalBatch = container.items.batch;
  const samples = [];
  const observe = async (kind, action) => {
    const sample = context.getStore();
    if (!sample) return action();
    sample[kind]++;
    let response;
    try { response = await action(); return response; }
    catch (error) { response = error; throw error; }
    finally {
      // ResourceResponse.requestCharge defaults to zero when the header is
      // missing. Do not turn that SDK convenience getter into false evidence.
      const charge = response?.headers?.['x-ms-request-charge'] ?? (response && Object.hasOwn(response, 'requestCharge') ? response.requestCharge : undefined);
      if (charge !== undefined && charge !== null && charge !== '' && Number.isFinite(Number(charge)) && Number(charge) >= 0) {
        sample.knownRequestCharge += Number(charge);
        sample.knownChargeByKind[kind] += Number(charge);
      }
      else sample.missingChargeResponses++;
      // Count each SDK response once per status, including inner batch failures.
      const codes = new Set([response?.statusCode, response?.code, ...(response?.result ?? []).map(r => r.statusCode)]);
      for (const code of [409, 412, 429, 503]) if (codes.has(code)) sample.sdkStatuses[code]++;
    }
  };
  container.item = function (...args) {
    const item = originalItem.apply(this, args);
    const read = item.read;
    item.read = function (...options) { return observe('pointReads', () => read.apply(this, options)); };
    return item;
  };
  container.items.batch = function (...args) { return observe('batchAttempts', () => originalBatch.apply(this, args)); };
  return {
    samples,
    async run(phase, action) {
      const sample = { phase, pointReads: 0, batchAttempts: 0, knownRequestCharge: 0, missingChargeResponses: 0,
        knownChargeByKind: { pointReads: 0, batchAttempts: 0 },
        sdkStatuses: { 409: 0, 412: 0, 429: 0, 503: 0 }, outcome: 'failed', responseBytes: 0 };
      samples.push(sample);
      const start = performance.now();
      try {
        return await context.run(sample, async () => {
          const response = await action();
          sample.outcome = response.status === 'conflict' ? 'conflict' : 'ok';
          sample.responseBytes = bytes(response);
          return response;
        });
      } catch (error) {
        sample.outcome = error?.code === 'account_busy' ? 'account_busy' : 'failed';
        sample.httpStatus = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.code) ? error.code : null;
        throw error;
      } finally {
        sample.durationMs = performance.now() - start;
        sample.requestCharge = sample.missingChargeResponses ? null : sample.knownRequestCharge;
      }
    },
    restore() { container.item = originalItem; container.items.batch = originalBatch; }
  };
}

export function summarize(samples) {
  return [...new Set(samples.map(s => s.phase))].map(phase => {
    const rows = samples.filter(s => s.phase === phase);
    const sum = key => rows.reduce((total, row) => total + row[key], 0);
    return { phase, samples: rows.length, durationMs: percentiles(rows.map(s => s.durationMs)),
      responseBytes: { total: sum('responseBytes'), ...percentiles(rows.map(s => s.responseBytes)) },
      pointReads: sum('pointReads'), batchAttempts: sum('batchAttempts'),
      knownRequestCharge: sum('knownRequestCharge'), missingChargeResponses: sum('missingChargeResponses'),
      knownChargeByKind: Object.fromEntries(['pointReads', 'batchAttempts'].map(kind => [kind, rows.reduce((n, row) => n + row.knownChargeByKind[kind], 0)])),
      requestCharge: sum('missingChargeResponses') ? null : sum('knownRequestCharge'),
      sdkStatuses: Object.fromEntries([409, 412, 429, 503].map(code => [code, rows.reduce((n, row) => n + row.sdkStatuses[code], 0)])),
      outcomes: Object.fromEntries(['ok', 'conflict', 'account_busy', 'failed'].map(outcome => [outcome, rows.filter(s => s.outcome === outcome).length])) };
  });
}

export function workloadOperation(accountId, size, id, version) {
  // Near-limit combines the existing text field limits into a ~30 KiB record.
  const fields = { title: `Task ${id} revision ${version}`, description: size === 'near-limit' ? 'n'.repeat(4000) : 'A representative task note.',
    ...(!version ? { workspaceId: 'personal', collectionRefs: [] } : {}) };
  if (!version) Object.assign(fields, size === 'near-limit'
    ? { originalText: 'o'.repeat(16000), selectedText: 's'.repeat(8000), sourceTitle: 't'.repeat(2000) }
    : { originalText: `Task ${id}` });
  return validateOperation({ apiVersion: 1, accountId, operationId: `op-${id}-${version}`,
    mutations: [{ type: 'item', id: `item-${id}`, action: version ? 'update' : 'create', expectedVersion: version, fields }] });
}

export async function measurementScenarios({ store, container, check, report, checkpoint = async () => {}, records = 100, editRounds = 5 }) {
  const meter = measureStore(container);
  report.measurements = [];
  try {
    for (const size of ['small', 'near-limit']) for (const concurrency of [1, 2, 8]) {
      const result = { size, concurrency, records, editRounds, status: 'RUNNING', summaries: [], pages: [] };
      report.measurements.push(result);
      const startIndex = meter.samples.length;
      try {
        await check(`${size} records, ${concurrency} concurrent callers`, async () => {
          const accountId = `measure-${size}-${concurrency}`;
          const send = (phase, op) => meter.run(phase, () => store.commit(accountId, op));
          const writeRound = async version => {
            for (let id = 0; id < result.records; id += concurrency) {
              const operations = Array.from({ length: Math.min(concurrency, result.records - id) }, (_, i) => workloadOperation(accountId, size, id + i, version));
              // Settle every writer before recovery/cleanup, even on unexpected errors.
              const replies = await Promise.allSettled(operations.map(op => send(version ? 'edit' : 'create', op)));
              for (const [i, reply] of replies.entries()) {
                if (reply.status === 'fulfilled') assert.equal(reply.value.status, 'committed');
                else {
                  assert.equal(reply.reason.code, 'account_busy');
                  assert.equal((await send('retry-busy', operations[i])).status, 'committed');
                }
              }
            }
          };
          const pull = async (phase, after) => {
            let pages = 0, payloadBytes = 0;
            while (true) {
              assert.ok(++pages <= result.records * (result.editRounds + 1), 'paging must terminate');
              const page = await meter.run(phase, () => store.changes(accountId, after, 50));
              assert.ok(page.nextAfter > after);
              assert.deepEqual(page.entries.map(e => e.sequence), Array.from({ length: page.entries.length }, (_, i) => after + i + 1));
              payloadBytes += bytes(page); after = page.nextAfter;
              if (!page.hasMore) break;
            }
            result.pages.push({ phase, pages, payloadBytes, through: after });
            return after;
          };
          await writeRound(0);
          assert.equal(await pull('initial-catch-up', 0), result.records);
          for (let version = 1; version <= result.editRounds; version++) await writeRound(version);
          assert.equal(await pull('incremental-catch-up', result.records), result.records * (result.editRounds + 1));
          assert.equal(await pull('full-history-catch-up', 0), result.records * (result.editRounds + 1));
          // Repeat one acknowledged edit unchanged: no additional batch/sequence.
          const replay = await send('receipt-replay', workloadOperation(accountId, size, 0, result.editRounds));
          assert.equal(replay.records[0].version, result.editRounds + 1);
          assert.equal(meter.samples.at(-1).batchAttempts, 0);
        });
        result.status = 'PASS';
      } catch (error) { result.status = 'FAIL'; throw error; }
      finally {
        result.summaries = summarize(meter.samples.slice(startIndex));
        await checkpoint();
      }
    }
  } finally { meter.restore(); }
}
