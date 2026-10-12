import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyAccountErasure, createAccountErasurePlan } from '../api/v1/account-erasure.mjs';

function usage() {
  return 'Usage:\n  node scripts/erase-account.mjs plan --account <exact-id> --verified-principal <exact-id> --backup-expires-after <utc> --out <new-plan.json>\n  node scripts/erase-account.mjs apply --plan <plan.json> --confirm <erasure-id> [--restore-replay]';
}
function option(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
async function writeExclusive(path, value) {
  const file = await open(path, 'wx');
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
}

export async function main(args = process.argv.slice(2), env = process.env, injected = {}) {
  const mode = args[0];
  if (!['plan', 'apply'].includes(mode) || !env.CosmosDbConnectionSetting && !injected.container) {
    console.error(`${usage()}\nSet CosmosDbConnectionSetting, COSMOS_DB and COSMOS_CONTAINER for the explicitly approved target.`);
    return 1;
  }
  const db = injected.container ? injected : await import('../api/shared/db.mjs');
  try {
    if (mode === 'plan') {
      const accountId = option(args, '--account'), authenticatedPrincipalId = option(args, '--verified-principal');
      const backupExpiresAfterUtc = option(args, '--backup-expires-after'), out = option(args, '--out');
      if (!out) throw new Error(usage());
      const plan = await createAccountErasurePlan(db.container, accountId, { authenticatedPrincipalId, backupExpiresAfterUtc });
      await writeExclusive(out, plan);
      console.log(`Dry run complete for the exact authenticated account: ${plan.counts.privateRecords} private records, ${plan.counts.privateReceipts} receipts, ${plan.counts.privateChanges} history rows, ${plan.counts.sharedOwnedLists} owned shared lists and ${plan.counts.sharedMemberships} memberships. Plan saved without user content. Erasure ID: ${plan.erasureId}`);
    } else {
      const path = option(args, '--plan'), confirm = option(args, '--confirm');
      if (!path) throw new Error(usage());
      const plan = JSON.parse(await readFile(path, 'utf8'));
      const result = await applyAccountErasure(db.container, plan, { confirm, restoreReplay: args.includes('--restore-replay') });
      console.log(JSON.stringify(result));
    }
    return 0;
  } catch (error) {
    console.error(`Account erasure did not complete (${error.code || 'invalid_request'}). No user content was logged.`);
    return 1;
  } finally { db.client?.dispose?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
