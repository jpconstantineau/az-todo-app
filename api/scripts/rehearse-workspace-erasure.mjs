import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { document, recordId } from '../api/v1/contract.mjs';
import { applyWorkspaceErasure, createWorkspaceErasurePlan, readAccountDocuments } from '../api/v1/workspace-erasure.mjs';

const partitionKey = { paths: ['/UserID', '/ObjectType', '/ObjectID'], kind: 'MultiHash', version: 2 };
const indexingPolicy = { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: [] };
const synthetic = (account, id, fields) => document(account, recordId(fields.type, id), { kind: 'record', record: {
  id, accountId: account, version: 1, createdUtc: '2026-01-01T00:00:00.000Z', updatedUtc: '2026-01-01T00:00:00.000Z', deleted: false, deletedUtc: null, ...fields
} });
function seed(accountA, accountB) {
  const operationId = 'synthetic-operation';
  const work = synthetic(accountA, 'work', { type: 'workspace', title: 'Synthetic work', archived: false });
  const family = synthetic(accountA, 'family', { type: 'workspace', title: 'Synthetic family', archived: false });
  const task = synthetic(accountA, 'task', { type: 'item', title: 'Synthetic private task', workspaceId: 'work', collectionRefs: [], status: 'inbox' });
  const other = synthetic(accountA, 'other', { type: 'item', title: 'Synthetic retained task', workspaceId: 'family', collectionRefs: [], status: 'inbox' });
  const response = { apiVersion: 1, accountId: accountA, operationId, sequence: 1, status: 'committed', records: [work.record, family.record, task.record, other.record] };
  return [document(accountA, 'state', { kind: 'state', sequence: 1 }), work, family, task, other,
    document(accountA, `receipt:${operationId}`, { kind: 'receipt', requestHash: 'synthetic', response }),
    document(accountA, 'change:1', { kind: 'change', sequence: 1, response }),
    document(accountB, 'state', { kind: 'state', sequence: 1 }),
    synthetic(accountB, 'work', { type: 'workspace', title: 'Other account', archived: false }),
    synthetic(accountB, 'task', { type: 'item', title: 'Other account task', workspaceId: 'work', collectionRefs: [], status: 'inbox' })];
}
async function writeSeed(container, rows) { for (const row of rows) await container.items.create(row); }
async function verify(container, accountA, accountB) {
  const a = await readAccountDocuments(container, accountA), b = await readAccountDocuments(container, accountB);
  if (a.some(row => row.kind === 'record' && (row.record.id === 'work' || row.record.workspaceId === 'work'))) throw new Error('target remained');
  if (!a.some(row => row.kind === 'record' && row.record.id === 'other') || b.filter(row => row.kind === 'record').length !== 2) throw new Error('isolation failed');
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 2 || args[0] !== '--isolated-account' || !env.WORKSPACE_ERASURE_REHEARSAL_CONNECTION_STRING) {
    console.error('Usage: node scripts/rehearse-workspace-erasure.mjs --isolated-account <new-report.jsonl>\nSet WORKSPACE_ERASURE_REHEARSAL_CONNECTION_STRING for a disposable Cosmos NoSQL account.');
    return 1;
  }
  let output;
  try { output = await open(args[1], 'wx'); }
  catch { console.error('Choose a new evidence path; existing reports are never overwritten.'); return 1; }
  const report = { formatVersion: 1, startedUtc: new Date().toISOString(), status: 'RUNNING', phase: 'initializing',
    databaseId: `az-todo-workspace-erasure-${randomUUID()}`, containers: ['live', 'restored'], checks: [], cleanup: 'pending' };
  const checkpoint = async () => { await output.write(JSON.stringify(report) + '\n'); await output.sync(); };
  let client, database;
  try {
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    report.node = process.version; report.cosmosSdk = lock.packages['node_modules/@azure/cosmos'].version;
    try {
      const cwd = new URL('../..', import.meta.url);
      report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      report.dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch { report.commit = null; report.dirty = null; }
    await checkpoint();
    const { CosmosClient } = await import('@azure/cosmos');
    client = new CosmosClient(env.WORKSPACE_ERASURE_REHEARSAL_CONNECTION_STRING);
    ({ database } = await client.databases.create({ id: report.databaseId }));
    const live = (await database.containers.create({ id: 'live', partitionKey, indexingPolicy })).container;
    const restored = (await database.containers.create({ id: 'restored', partitionKey, indexingPolicy })).container;
    const accountA = `a-${randomUUID()}`, accountB = `b-${randomUUID()}`, rows = seed(accountA, accountB);
    report.phase = 'seed'; await checkpoint(); await writeSeed(live, rows);
    const plan = createWorkspaceErasurePlan(await readAccountDocuments(live, accountA), accountA, 'work');
    report.expected = plan.counts;
    report.phase = 'interruption-resume'; await checkpoint();
    try { await applyWorkspaceErasure(live, plan, { confirm: plan.erasureId, interruptAfter: 'changes' }); }
    catch (error) { if (error.code !== 'interrupted') throw error; }
    const actual = await applyWorkspaceErasure(live, plan, { confirm: plan.erasureId });
    await verify(live, accountA, accountB); report.checks.push({ name: 'interruption-resume', status: 'PASS', actual: actual.counts });
    report.phase = 'logical-restore-guard'; await checkpoint(); await writeSeed(restored, rows);
    const restorePlan = createWorkspaceErasurePlan(await readAccountDocuments(restored, accountA), accountA, 'work', plan.erasureId);
    await applyWorkspaceErasure(restored, restorePlan, { confirm: plan.erasureId }); await verify(restored, accountA, accountB);
    report.checks.push({ name: 'logical-restore-before-serving', status: 'PASS' }); report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = { phase: report.phase, code: error.code || 'unexpected' };
  } finally {
    report.phase = 'cleanup';
    if (database) try { await database.delete(); report.cleanup = 'deleted'; } catch { report.cleanup = 'failed'; report.status = 'FAIL'; }
    report.finishedUtc = new Date().toISOString();
    try { await checkpoint(); } finally { client?.dispose(); await output.close(); }
  }
  console.log(`Workspace erasure rehearsal ${report.status}; cleanup: ${report.cleanup}. Evidence saved without task content.`);
  return report.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
