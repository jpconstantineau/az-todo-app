import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documents, faults } from './harness.mjs';
import { rehearse } from '../scripts/rehearse-cosmos.mjs';
import { protocolScenarios } from '../scripts/cosmos-scenarios.mjs';
const store = await import('../api/v1/store.mjs');
const { container } = await import('../api/shared/db.mjs');

test('the live Cosmos scenario set also passes against the production store with local test storage', async () => {
  documents.length = 0;
  Object.assign(faults, { nextWrite: false, batchIndex: -1, loseBatchResponse: false });
  const checks = [];
  const sdkContainer = { ...container, items: { ...container.items, async batch(...args) {
    const result = await container.items.batch(...args);
    return { ...result, code: result.code === 409 ? 207 : result.code };
  } } };
  await protocolScenarios({ store, container: sdkContainer, check: async (name, action) => { await action(); checks.push(name); } });
  assert.equal(checks.length, 7);
  assert.ok(documents.some(d => d.kind === 'record' && d.record.deleted));
  assert.ok(documents.some(d => d.kind === 'receipt' && d.response.status === 'conflict'));
});

function fixture({ consistency = 'Session', multiWrite = false, regions = 1, createFailure, containerFailure, cleanupFailure } = {}) {
  const calls = [];
  const report = {};
  const database = {
    containers: { async create(definition) {
      calls.push(['container', definition]);
      if (containerFailure) throw containerFailure;
      return { container: { async read() { return { resource: definition }; } } };
    } },
    async delete() { calls.push(['delete']); if (cleanupFailure) throw cleanupFailure; }
  };
  const client = {
    async getDatabaseAccount() { calls.push(['account']); return { resource: {
      consistencyPolicy: consistency, enableMultipleWritableLocations: multiWrite,
      writableLocations: Array.from({ length: regions }, () => ({ name: 'test-region' }))
    } }; },
    databases: { async create({ id }) {
      calls.push(['create', id]);
      if (createFailure) throw createFailure;
      return { database };
    } }
  };
  const loadStore = async (dbId, containerId) => { calls.push(['store', dbId, containerId]); return {}; };
  const scenarios = async ({ check }) => check('synthetic lifecycle check', async () => {});
  return { client, loadStore, report, calls, scenarios };
}

test('rehearsal creates only a fresh generated target, records its configuration, and deletes it', async () => {
  const f = fixture();
  const snapshots = [];
  await rehearse({ ...f, checkpoint: async () => snapshots.push(structuredClone(f.report)) });
  assert.equal(f.report.status, 'PASS');
  assert.equal(f.report.cleanup, 'deleted');
  assert.match(f.report.databaseId, /^az-todo-rehearsal-[0-9a-f-]{36}$/);
  assert.deepEqual(f.calls.map(c => c[0]), ['account', 'create', 'container', 'store', 'delete']);
  assert.deepEqual(f.calls[3], ['store', f.report.databaseId, 'protocol']);
  assert.ok(snapshots.some(s => s.cleanup === 'creation_pending' && s.databaseId === f.report.databaseId));
  assert.deepEqual(f.report.environment.partitionKey.paths, ['/UserID', '/ObjectType', '/ObjectID']);
  assert.equal(f.report.checks[0].status, 'PASS');
  assert.equal(f.report.environment.consistency, 'Session');
});

test('preflight rejects weak consistency or multi-write topology before resource creation', async () => {
  for (const options of [{ consistency: 'Eventual' }, { consistency: 'ConsistentPrefix' }, { multiWrite: true }, { regions: 2 }, { regions: 0 }]) {
    const f = fixture(options);
    await rehearse(f);
    assert.equal(f.report.status, 'FAIL');
    assert.equal(f.report.failure.phase, 'account preflight');
    assert.equal(f.report.cleanup, 'not_created');
    assert.deepEqual(f.calls, [['account']]);
  }
});

test('failed checks and container creation still clean up; raw errors never enter the evidence', async () => {
  const error = Object.assign(new Error('AccountKey=private; endpoint https://private.example; task text'), { code: 503 });
  for (const location of ['container', 'scenario']) {
    const f = fixture({ containerFailure: location === 'container' ? error : undefined });
    if (location === 'scenario') f.scenarios = async ({ check }) => check('injected storage failure', async () => { throw error; });
    await rehearse(f);
    assert.equal(f.report.status, 'FAIL');
    assert.equal(f.report.cleanup, 'deleted');
    assert.equal(f.calls.at(-1)[0], 'delete');
    assert.equal(f.report.failure.code, 503);
    assert.doesNotMatch(JSON.stringify(f.report), /private|AccountKey|task text/);
    if (location === 'scenario') assert.equal(f.report.checks[0].status, 'FAIL');
  }
});

test('ambiguous create and failed deletion report required cleanup without deleting an unowned target', async () => {
  const create = fixture({ createFailure: Object.assign(new Error('lost create response'), { code: 503 }) });
  await rehearse(create);
  assert.equal(create.report.status, 'FAIL');
  assert.equal(create.report.cleanup, 'creation_pending');
  assert.equal(create.calls.some(c => c[0] === 'delete'), false);
  const cleanup = fixture({ cleanupFailure: Object.assign(new Error('cannot delete'), { code: 403 }) });
  await rehearse(cleanup);
  assert.equal(cleanup.report.status, 'FAIL');
  assert.equal(cleanup.report.cleanup, 'failed');
  assert.equal(cleanup.report.cleanupFailure.code, 403);
});

test('CLI requires explicit isolated-account opt-in and a dedicated credential, and never overwrites evidence', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'cosmos-rehearsal-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/rehearse-cosmos.mjs', import.meta.url));
  const output = join(folder, 'evidence.json');
  const env = { ...process.env, CosmosDbConnectionSetting: 'must-not-use-app-credentials' };
  delete env.COSMOS_REHEARSAL_CONNECTION_STRING;
  for (const args of [[], ['--isolated-account', output], ['--existing-database', 'production', output]]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /must-not-use-app-credentials/);
  }
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await writeFile(output, 'prior evidence');
  assert.throws(() => execFileSync(process.execPath, [script, '--isolated-account', output], {
    env: { ...env, COSMOS_REHEARSAL_CONNECTION_STRING: 'invalid-but-must-not-be-read' }, stdio: 'pipe'
  }), /Existing evidence is never overwritten/);
  assert.equal(await readFile(output, 'utf8'), 'prior evidence');
  const failedOutput = join(folder, 'invalid-credential.jsonl');
  const invalid = spawnSync(process.execPath, [script, '--isolated-account', failedOutput], {
    env: { ...env, COSMOS_REHEARSAL_CONNECTION_STRING: 'invalid-private-credential' }, encoding: 'utf8'
  });
  assert.equal(invalid.status, 1);
  const evidence = await readFile(failedOutput, 'utf8');
  assert.equal(JSON.parse(evidence.trim()).status, 'FAIL');
  assert.doesNotMatch(evidence + invalid.stdout + invalid.stderr, /invalid-private-credential|must-not-use-app-credentials/);
});
