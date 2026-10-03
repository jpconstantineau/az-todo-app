import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { protocolScenarios } from './cosmos-scenarios.mjs';

const partitionKey = { paths: ['/UserID', '/ObjectType', '/ObjectID'], kind: 'MultiHash', version: 2 };
const indexingPolicy = { automatic: true, indexingMode: 'consistent', includedPaths: [{ path: '/*' }], excludedPaths: [{ path: '/"_etag"/?' }] };
// SDK exceptions can include URLs, headers and credentials. Record only a numeric
// HTTP status or known assertion code, never the raw exception/message/stack.
const failureCode = error => Number.isInteger(error?.code) ? error.code : error?.code === 'ERR_ASSERTION' ? 'assertion_failed' : 'request_failed';

export async function rehearse({ client, loadStore, report, checkpoint = async () => {}, scenarios = protocolScenarios }) {
  report.databaseId = 'az-todo-rehearsal-' + randomUUID();
  report.containerId = 'protocol';
  report.status = 'RUNNING';
  report.cleanup = 'not_created';
  report.checks = [];
  let database;
  const check = async (name, action) => {
    const result = { name, status: 'RUNNING' };
    report.checks.push(result);
    await checkpoint();
    const start = performance.now();
    try { await action(); result.status = 'PASS'; }
    catch (error) { result.status = 'FAIL'; result.code = failureCode(error); throw error; }
    finally { result.durationMs = Math.round(performance.now() - start); await checkpoint(); }
  };
  try {
    report.phase = 'account preflight';
    await checkpoint();
    const { resource: account } = await client.getDatabaseAccount();
    assert.ok(['Session', 'BoundedStaleness', 'Strong'].includes(account.consistencyPolicy), 'Session or stronger consistency is required');
    assert.equal(account.enableMultipleWritableLocations, false, 'multi-write accounts are unsupported');
    assert.equal(account.writableLocations.length, 1, 'exactly one write region is required');
    report.environment = { consistency: account.consistencyPolicy, writeRegions: account.writableLocations.map(location => location.name) };
    report.phase = 'create temporary database';
    // Record the exact generated ID before issuing any create, for manual cleanup
    // if the process terminates or the create acknowledgement is lost.
    report.cleanup = 'creation_pending';
    await checkpoint();
    const created = await client.databases.create({ id: report.databaseId });
    database = created.database;
    report.cleanup = 'pending';
    report.phase = 'create temporary container';
    await checkpoint();
    const { container } = await database.containers.create({ id: report.containerId, partitionKey, indexingPolicy });
    const { resource } = await container.read();
    assert.deepEqual(resource.partitionKey.paths, partitionKey.paths);
    assert.equal(resource.partitionKey.kind, partitionKey.kind);
    assert.equal(resource.partitionKey.version, 2);
    assert.equal(resource.indexingPolicy.indexingMode, 'consistent');
    report.environment.partitionKey = resource.partitionKey;
    report.environment.indexingPolicy = resource.indexingPolicy;
    report.phase = 'protocol scenarios';
    const store = await loadStore(report.databaseId, report.containerId);
    await scenarios({ store, container, check });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = { phase: report.phase, code: failureCode(error) };
  } finally {
    if (database) {
      report.phase = 'cleanup';
      try {
        await database.delete();
        report.cleanup = 'deleted';
      } catch (error) {
        report.cleanup = 'failed'; report.status = 'FAIL';
        report.cleanupFailure = { code: failureCode(error) };
      }
    }
    report.finishedUtc = new Date().toISOString();
    await checkpoint();
  }
  return report;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 2 || args[0] !== '--isolated-account' || !env.COSMOS_REHEARSAL_CONNECTION_STRING) {
    console.error('Usage: node scripts/rehearse-cosmos.mjs --isolated-account <new-report.jsonl>\nSet COSMOS_REHEARSAL_CONNECTION_STRING to a disposable, single-write-region Cosmos NoSQL account with Session or stronger consistency. This command creates and deletes a temporary database and consumes Azure resources.');
    return 1;
  }
  let output;
  try { output = await open(args[1], 'wx'); }
  catch { console.error('Cannot create report; choose a new writable path. Existing evidence is never overwritten.'); return 1; }
  const report = { formatVersion: 1, startedUtc: new Date().toISOString(), node: process.version,
    scope: 'Cosmos storage protocol only; SWA authentication, browser queues, migration, backup restoration and capacity are not verified.' };
  const checkpoint = async () => {
    // Append snapshots so an interrupted write cannot erase the previously
    // recorded database ID needed for cleanup. Read the last complete line.
    await output.write(JSON.stringify(report) + '\n');
    await output.sync();
  };
  let client, storeClient;
  try {
    const cwd = new URL('../..', import.meta.url);
    try {
      report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      report.dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch { report.commit = null; report.dirty = null; }
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    report.cosmosSdk = lock.packages['node_modules/@azure/cosmos'].version;
    const { CosmosClient } = await import('@azure/cosmos');
    client = new CosmosClient(env.COSMOS_REHEARSAL_CONNECTION_STRING);
    await rehearse({ client, report, checkpoint, loadStore: async (databaseId, containerId) => {
      // Only this standalone process is changed. Never use app database defaults.
      process.env.CosmosDbConnectionSetting = env.COSMOS_REHEARSAL_CONNECTION_STRING;
      process.env.COSMOS_DB = databaseId;
      process.env.COSMOS_CONTAINER = containerId;
      const db = await import('../api/shared/db.mjs');
      storeClient = db.client;
      return import('../api/v1/store.mjs');
    } });
    console.log(`Cosmos rehearsal ${report.status}; cleanup: ${report.cleanup}. Evidence saved to ${args[1]}.`);
    return report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    report.status = 'FAIL'; report.failure = { phase: 'runner', code: failureCode(error) };
    try { await checkpoint(); } catch { /* Report path failure is reported without SDK details. */ }
    console.error('Rehearsal failed. Inspect the report and its temporary database cleanup status.');
    return 1;
  } finally {
    storeClient?.dispose(); client?.dispose(); await output.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
