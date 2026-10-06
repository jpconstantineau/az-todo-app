import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createWorkspaceErasurePlan, applyWorkspaceErasure, readAccountDocuments } from '../api/v1/workspace-erasure.mjs';

function usage() {
  return 'Usage:\n  node scripts/erase-workspace.mjs plan --account <id> --workspace <id> --out <new-plan.json>\n  node scripts/erase-workspace.mjs apply --plan <plan.json> --confirm <erasure-id>';
}
function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
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
      const accountId = option(args, '--account'), workspaceId = option(args, '--workspace'), out = option(args, '--out');
      if (!out) throw new Error(usage());
      const documents = await readAccountDocuments(db.container, accountId);
      const plan = createWorkspaceErasurePlan(documents, accountId, workspaceId);
      await writeExclusive(out, plan);
      console.log(`Dry run complete for the explicit account/workspace target: ${plan.counts.records} records, ${plan.counts.receipts} receipts, ${plan.counts.changes} change rows. Plan saved without task text. Erasure ID: ${plan.erasureId}`);
    } else {
      const path = option(args, '--plan'), confirm = option(args, '--confirm');
      if (!path) throw new Error(usage());
      const plan = JSON.parse(await readFile(path, 'utf8'));
      const result = await applyWorkspaceErasure(db.container, plan, { confirm });
      console.log(`Workspace erasure ${result.status}; completed sequence ${result.completedSequence ?? 'already recorded'}. Keep the plan as protected restore evidence for the documented backup lifetime.`);
    }
    return 0;
  } catch (error) {
    console.error(`Workspace erasure did not complete (${error.code || 'invalid_request'}). No task content was logged.`);
    return 1;
  } finally { db.client?.dispose?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
