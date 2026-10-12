import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { document, recordId } from '../api/v1/contract.mjs';
import { accountErasureFenceId, applyAccountErasure, createAccountErasurePlan, readPrivateDocuments } from '../api/v1/account-erasure.mjs';

const partitionKey = { paths: ['/UserID', '/ObjectType', '/ObjectID'], kind: 'MultiHash', version: 2 };
const indexingPolicy = { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: [] };
const actorHash = value => createHash('sha256').update(value).digest('hex');
const privateRecord = (account, id, title) => document(account, recordId('item', id), { kind: 'record', record: {
  type: 'item', id, accountId: account, title, workspaceId: 'personal', collectionRefs: [], status: 'inbox', version: 1,
  createdUtc: '2026-01-01T00:00:00.000Z', updatedUtc: '2026-01-01T00:00:00.000Z', deleted: false, deletedUtc: null
} });
const sharedPartition = listId => ({ UserID: `shared:${listId}`, ObjectType: 'shared-list', ObjectID: 'v1', ttl: -1 });
function sharedList(listId, ownerId, members, title) {
  return { id: 'list', ...sharedPartition(listId), kind: 'shared-list', listId, ownerId, title, revision: 1, deleted: false,
    items: [{ id: 'synthetic-item', title: 'Synthetic collaborative item', completed: false, deleted: false }], members, invitations: [] };
}
function sharedReceipt(listId, accountId) {
  return { id: `receipt:${actorHash(accountId)}:synthetic-operation`, ...sharedPartition(listId), kind: 'shared-receipt', requestHash: 'synthetic',
    response: { apiVersion: 1, accountId, listId, operationId: 'synthetic-operation', revision: 1 } };
}
function seed(accountA, accountB) {
  return [
    document(accountA, 'state', { kind: 'state', sequence: 1 }), privateRecord(accountA, 'a-private', 'Synthetic A private'),
    document(accountB, 'state', { kind: 'state', sequence: 1 }), privateRecord(accountB, 'b-private', 'Synthetic B private'),
    sharedList('a-owned', accountA, [{ accountId: accountB, name: 'Synthetic B', permissions: ['view'] }], 'Synthetic A owned'),
    sharedReceipt('a-owned', accountA), sharedReceipt('a-owned', accountB),
    sharedList('b-owned', accountB, [{ accountId: accountA, name: 'Synthetic A', permissions: ['view'] }], 'Synthetic B owned'),
    sharedReceipt('b-owned', accountA), sharedReceipt('b-owned', accountB)
  ];
}
async function writeRows(container, rows) { for (const row of rows) await container.items.create(row); }
async function verify(container, accountA, accountB) {
  const a = await readPrivateDocuments(container, accountA), b = await readPrivateDocuments(container, accountB);
  if (a.length !== 1 || a[0].id !== accountErasureFenceId || !b.some(row => row.id === recordId('item', 'b-private')) || !b.some(row => row.id === recordId('item', 'b-post-backup'))) throw new Error('private isolation failed');
  const { resources } = await container.items.query({ query: "SELECT * FROM c WHERE c.kind='shared-list'" }).fetchAll();
  if (resources.some(list => list.ownerId === accountA || list.members.some(member => member.accountId === accountA))) throw new Error('shared identity remained');
  const retained = resources.find(list => list.ownerId === accountB);
  if (!retained?.items.some(item => item.id === 'synthetic-item')) throw new Error('collaborative content was not retained');
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 2 || args[0] !== '--isolated-account' || !env.ACCOUNT_ERASURE_REHEARSAL_CONNECTION_STRING || !Number.isFinite(Date.parse(env.ACCOUNT_ERASURE_BACKUP_EXPIRES_AFTER_UTC))) {
    console.error('Usage: node scripts/rehearse-account-erasure.mjs --isolated-account <new-report.jsonl>\nSet ACCOUNT_ERASURE_REHEARSAL_CONNECTION_STRING and ACCOUNT_ERASURE_BACKUP_EXPIRES_AFTER_UTC for a disposable Cosmos account.');
    return 1;
  }
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  const safeDirectory = cwd.replaceAll('\\', '/');
  let commit;
  try {
    commit = execFileSync('git', ['-c', `safe.directory=${safeDirectory}`, 'rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (execFileSync('git', ['-c', `safe.directory=${safeDirectory}`, 'status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) {
      console.error('Run the rehearsal from a clean candidate commit.');
      return 1;
    }
  } catch { console.error('The exact clean candidate commit could not be recorded.'); return 1; }
  let output;
  try { output = await open(args[1], 'wx'); } catch { console.error('Choose a new evidence path; existing reports are never overwritten.'); return 1; }
  const report = { formatVersion: 1, startedUtc: new Date().toISOString(), status: 'RUNNING', phase: 'initializing',
    databaseId: `az-todo-account-erasure-${randomUUID()}`, containers: ['live', 'restored-disabled'], checks: [],
    backupPolicyObserved: { lastPreErasureCopyExpiresAfterUtc: new Date(env.ACCOUNT_ERASURE_BACKUP_EXPIRES_AFTER_UTC).toISOString() },
    commit, dirty: false, cleanup: 'pending' };
  const checkpoint = async () => { await output.write(JSON.stringify(report) + '\n'); await output.sync(); };
  let client, database;
  try {
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    report.node = process.version; report.cosmosSdk = lock.packages['node_modules/@azure/cosmos'].version;
    await checkpoint();
    const { CosmosClient } = await import('@azure/cosmos');
    client = new CosmosClient(env.ACCOUNT_ERASURE_REHEARSAL_CONNECTION_STRING);
    ({ database } = await client.databases.create({ id: report.databaseId }));
    const live = (await database.containers.create({ id: 'live', partitionKey, indexingPolicy })).container;
    const restored = (await database.containers.create({ id: 'restored-disabled', partitionKey, indexingPolicy })).container;
    const accountA = `a-${randomUUID()}`, accountB = `b-${randomUUID()}`, rows = seed(accountA, accountB);
    report.phase = 'seed'; await checkpoint(); await writeRows(live, rows); await writeRows(restored, rows);
    const plan = await createAccountErasurePlan(live, accountA, { authenticatedPrincipalId: accountA, backupExpiresAfterUtc: env.ACCOUNT_ERASURE_BACKUP_EXPIRES_AFTER_UTC });
    report.candidate = { accountHash: actorHash(accountA), erasureId: plan.erasureId, expected: plan.counts };
    report.phase = 'fence-interruption-resume'; await checkpoint();
    try { await applyAccountErasure(live, plan, { confirm: plan.erasureId, interruptAfter: 'private' }); }
    catch (error) { if (error.code !== 'interrupted') throw error; }
    const liveOutcome = await applyAccountErasure(live, plan, { confirm: plan.erasureId });
    await writeRows(live, [privateRecord(accountB, 'b-post-backup', 'Synthetic B post-backup')]);
    await verify(live, accountA, accountB); report.checks.push({ name: 'live-interruption-resume', status: 'PASS', actual: liveOutcome.actualCounts });
    report.phase = 'disabled-restore-replay'; await checkpoint();
    await writeRows(restored, [privateRecord(accountB, 'b-post-backup', 'Synthetic B post-backup')]);
    const restoredOutcome = await applyAccountErasure(restored, plan, { confirm: plan.erasureId, restoreReplay: true });
    await verify(restored, accountA, accountB); report.checks.push({ name: 'disabled-restore-replay', status: 'PASS', actual: restoredOutcome.actualCounts });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = { phase: report.phase, code: error.code || 'unexpected' };
  } finally {
    report.phase = 'cleanup';
    if (database) try { await database.delete(); report.cleanup = 'deleted'; } catch { report.cleanup = 'failed'; report.status = 'FAIL'; }
    report.finishedUtc = new Date().toISOString();
    try { await checkpoint(); } finally { client?.dispose(); await output.close(); }
  }
  console.log(`Account erasure rehearsal ${report.status}; cleanup: ${report.cleanup}. Evidence saved without user content.`);
  return report.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
