import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import backup from "./fixtures/legacy-v1.json" with { type: "json" };
import { prepareMigration, verifyMigration, rollbackMigration } from "../scripts/migrate-v1.mjs";
import { digest } from "../api/v1/contract.mjs";
import { documents } from "./harness.mjs";
import { validateOperation } from "../api/v1/contract.mjs";
const { changes, commit } = await import("../api/v1/store.mjs");

test("migration rehearsal preserves owner, stable IDs, all persisted fields and links; rollback reproduces the backup", async t => {
  const prepared = prepareMigration(backup);
  assert.deepEqual(verifyMigration(prepared), prepared);
  assert.deepEqual(rollbackMigration(prepared), backup);
  assert.equal(digest(rollbackMigration(prepared)), digest(backup));
  assert.equal(prepared.report.records, 4);
  const alice = prepared.targetDocuments.find(d => d.kind === "record" && d.UserID === "alice" && d.record.type === "item");
  const source = backup.documents[1];
  for (const field of ["id", "title", "description", "originalText", "referenceLinks", "areas", "contexts", "status", "customLegacyField", "dueDateUtc"]) assert.deepEqual(alice.record[field], source[field]);
  assert.deepEqual([alice.UserID, alice.ObjectType, alice.ObjectID], ["alice", "sync", "v1"]);
  assert.equal(alice.record.accountId, "alice");

  // Rehearse loading the prepared target into an isolated store, then read and edit
  // it with the production API service. This does not certify real Cosmos import.
  documents.splice(0, documents.length, ...structuredClone(prepared.targetDocuments).map((doc, i) => ({ ...doc, _etag: `import-${i}` })));
  const feed = await changes("alice", 0, 50);
  assert.equal(feed.entries.length, 2);
  assert.equal(feed.nextAfter, 2);
  assert.doesNotMatch(JSON.stringify(feed), /Bob's/);
  const moved = await commit("alice", validateOperation({ apiVersion: 1, accountId: "alice", operationId: "post-migration-move",
    mutations: [{ type: "item", id: "milk", action: "update", expectedVersion: 1, fields: { listId: null, description: "New edit" } }] }));
  assert.equal(moved.sequence, 3);
  assert.equal(moved.records[0].id, "milk");
  assert.equal(moved.records[0].originalText, source.originalText);
  assert.deepEqual(moved.records[0].referenceLinks, source.referenceLinks);
  const linked = await commit("alice", validateOperation({ apiVersion: 1, accountId: "alice", operationId: "post-migration-project",
    mutations: [
      { type: "project", id: "home", action: "create", expectedVersion: 0, fields: { title: "Home", outcome: "Supplies ready" } },
      { type: "item", id: "milk", action: "update", expectedVersion: 2, fields: { projectId: "home", plannedDay: "2026-10-05" } }
    ] }));
  const linkedItem = linked.records.find(record => record.type === "item");
  assert.equal(linkedItem.id, source.id);
  assert.deepEqual(linkedItem.areas, source.areas);
  assert.equal(linkedItem.originalText, source.originalText);
  assert.equal(linkedItem.dueDateUtc, source.dueDateUtc);
  assert.equal(linkedItem.status, source.status);
  assert.equal(linkedItem.listId, null);
  assert.deepEqual(rollbackMigration(prepared), backup, "backup is unchanged by target edits; post-cutover edits require separate recovery");

  const folder = await mkdtemp(join(tmpdir(), "az-todo-migration-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../scripts/migrate-v1.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/legacy-v1.json", import.meta.url));
  const preparedPath = join(folder, "prepared.json");
  const restoredPath = join(folder, "restored.json");
  execFileSync(process.execPath, [script, "prepare", fixture, preparedPath]);
  execFileSync(process.execPath, [script, "rollback", preparedPath, restoredPath]);
  assert.deepEqual(JSON.parse(await readFile(restoredPath, "utf8")), backup);
  assert.throws(() => execFileSync(process.execPath, [script, "rollback", preparedPath, restoredPath], { stdio: "pipe" }), /EEXIST/, "never overwrite an existing backup/output");
});

test("migration rejects owner mismatches, orphan references, duplicate identities, unknown types and tampering", () => {
  for (const mutate of [
    data => { data.documents[1].userId = "bob"; },
    data => { data.documents[1].listId = data.documents[1].ObjectID = "missing"; },
    data => { data.documents.push(structuredClone(data.documents[1])); },
    data => { data.documents[1].ObjectType = "unexpected"; },
    data => { data.documents[1].ObjectID = "wrong-partition"; },
    data => { data.documents[1].description = "x".repeat(33000); }
  ]) {
    const bad = structuredClone(backup); mutate(bad);
    assert.throws(() => prepareMigration(bad));
  }
  const badBackup = prepareMigration(backup); badBackup.backup.documents[1].title = "Tampered";
  assert.throws(() => rollbackMigration(badBackup), /checksum/);
  const badTarget = prepareMigration(backup); badTarget.targetDocuments[0].UserID = "mallory";
  assert.throws(() => verifyMigration(badTarget), /differ/);
});

test('migration preserves workflow/date fields and custom statuses without interpreting historic values', () => {
  const source = structuredClone(backup);
  const fields = { status: 'historic-status', nextAction: false, waitingOn: 'Alex', startDateUtc: 'legacy date text',
    reviewDateUtc: '2026-11-01T06:30:00.000Z', dueDate: '2026-11-02', startDate: '2026-11-01', reviewDate: '2026-11-03' };
  Object.assign(source.documents[1], fields);
  const prepared = prepareMigration(source);
  const item = prepared.targetDocuments.find(doc => doc.kind === 'record' && doc.UserID === 'alice' && doc.record.type === 'item').record;
  for (const [name, value] of Object.entries(fields)) assert.equal(item[name], value);
  assert.deepEqual(rollbackMigration(prepared), source);
});
