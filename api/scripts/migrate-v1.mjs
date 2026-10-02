import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { bytes, canonical, digest, document, identifier, recordId, MAX_RECORD_BYTES } from "../api/v1/contract.mjs";

// Offline only: this tool never connects to Azure or modifies a source export.
export function prepareMigration(backup) {
  if (backup?.formatVersion !== 1 || !Array.isArray(backup.documents)) throw new Error("Expected {formatVersion:1, documents:[...]} legacy export.");
  const sourceHash = digest(backup);
  const targetDocuments = [];
  const accounts = new Map();
  const keys = new Set();
  const ownedLists = new Set(backup.documents.filter(doc => doc.type === "list").map(doc => canonical([doc.UserID, doc.id])));
  const legacy = [...backup.documents].sort((a, b) => canonical([a.UserID, a.ObjectType, a.id]).localeCompare(canonical([b.UserID, b.ObjectType, b.id])));
  for (const doc of legacy) {
    const owner = doc.UserID;
    if (typeof owner !== "string" || !owner || doc.userId !== owner) throw new Error(`Owner mismatch for ${doc.id}.`);
    if (!["list", "item", "userSettings"].includes(doc.ObjectType) || doc.type !== doc.ObjectType) throw new Error(`Unsupported record type for ${doc.id}; preserve the backup and reconcile explicitly.`);
    identifier(doc.id);
    const key = canonical([owner, doc.ObjectType, doc.id]);
    if (keys.has(key)) throw new Error(`Duplicate stable identity ${doc.id}; reconcile before migration.`);
    keys.add(key);
    if (doc.ObjectType === "userSettings") {
      if (doc.ObjectID !== "_meta" || doc.id !== "settings") throw new Error("Unexpected settings identity.");
      targetDocuments.push(document(owner, "legacy-settings", { kind: "legacy-settings", settings: structuredClone(doc) }));
      continue;
    }
    if (doc.ObjectID !== doc.listId || (doc.type === "list" && doc.id !== doc.listId)) throw new Error(`Partition/list identity mismatch for ${doc.id}.`);
    identifier(doc.listId, "listId");
    if (doc.type === "item" && !ownedLists.has(canonical([owner, doc.listId]))) throw new Error(`Missing owned list for ${doc.id}.`);
    if (typeof doc.title !== "string" || typeof doc.createdUtc !== "string" || typeof doc.updatedUtc !== "string") throw new Error(`Missing persisted text/timestamps for ${doc.id}.`);
    const record = structuredClone(doc);
    for (const field of ["UserID", "ObjectType", "ObjectID", "userId", "ttl", "_rid", "_self", "_etag", "_attachments", "_ts"]) delete record[field];
    Object.assign(record, { accountId: owner, version: 1, deleted: false, deletedUtc: null,
      originalText: doc.originalText ?? `${doc.title}${doc.description ? `\n${doc.description}` : ""}`,
      originalTextProvenance: doc.originalText === undefined ? "persisted-legacy-title-description" : "persisted-original" });
    if (bytes(record) > MAX_RECORD_BYTES) throw new Error(`Record ${doc.id} exceeds 32 KiB; migrate explicitly without truncation.`);
    const sequence = (accounts.get(owner) ?? 0) + 1;
    accounts.set(owner, sequence);
    const operationId = `migration-${digest([sourceHash, owner, doc.type, doc.id])}`;
    const response = { apiVersion: 1, accountId: owner, operationId, sequence, status: "committed", records: [record] };
    targetDocuments.push(
      document(owner, recordId(doc.type, doc.id), { kind: "record", record }),
      document(owner, `receipt:${operationId}`, { kind: "receipt", requestHash: digest(doc), response }),
      document(owner, `change:${sequence}`, { kind: "change", sequence, response })
    );
  }
  for (const [owner, sequence] of accounts) targetDocuments.push(document(owner, "state", { kind: "state", sequence }));
  return { formatVersion: 1, sourceHash, backup: structuredClone(backup), targetDocuments,
    report: { sourceDocuments: legacy.length, records: [...accounts.values()].reduce((a, b) => a + b, 0),
      targetDocuments: targetDocuments.length, accountSequences: Object.fromEntries(accounts),
      note: "Legacy fields and settings are preserved; missing original capture is derived only from persisted title/description and labeled. No source records have been changed." } };
}

export function verifyMigration(prepared) {
  if (prepared?.formatVersion !== 1 || digest(prepared.backup) !== prepared.sourceHash) throw new Error("Backup checksum mismatch.");
  const expected = prepareMigration(prepared.backup);
  if (canonical(prepared) !== canonical(expected)) throw new Error("Prepared documents/report differ from the verified backup. Recreate the migration.");
  return expected;
}
export function rollbackMigration(prepared) {
  return structuredClone(verifyMigration(prepared).backup);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, input, output] = process.argv.slice(2);
  if (!["prepare", "rollback"].includes(mode) || !input || !output) {
    throw new Error("Usage: node scripts/migrate-v1.mjs prepare|rollback input.json new-output.json");
  }
  const source = JSON.parse(await readFile(input, "utf8"));
  const result = mode === "prepare" ? prepareMigration(source) : rollbackMigration(source);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ mode, sourceHash: mode === "prepare" ? result.sourceHash : digest(result), documents: mode === "prepare" ? result.report : result.documents.length }));
}
