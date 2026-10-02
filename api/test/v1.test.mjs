import { test } from "node:test";
import assert from "node:assert/strict";
import { documents, faults, startServer } from "./harness.mjs";
import capture from "./fixtures/v1-operations.json" with { type: "json" };

async function fixture(t) {
  documents.length = 0;
  Object.assign(faults, { nextWrite: false, batchIndex: -1, loseBatchResponse: false });
  const server = await startServer();
  t.after(server.close);
  const request = async (path, { body, user = "alice", origin = server.url, raw, headers = {} } = {}) => {
    const response = await fetch(`${server.url}/api/v1/${path}`, {
      method: body || raw !== undefined ? "POST" : "GET",
      headers: { origin, "content-type": "application/json", ...(user ? { "x-ms-client-principal": Buffer.from(JSON.stringify({ userId: user, userRoles: ["authenticated"] })).toString("base64") } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined)
    });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("content-type"), /application\/json/);
    return { status: response.status, body: await response.json() };
  };
  return { request, post: (body, options) => request("operations", { body, ...options }),
    get: (type, id, user = "alice") => request(`records?accountId=${user}&type=${type}&id=${id}`, { user }) };
}
const edit = (operationId, id, expectedVersion, fields, action = "update", type = "item") => ({
  apiVersion: 1, accountId: "alice", operationId,
  mutations: [{ type, id, expectedVersion, action, ...(fields ? { fields } : {}) }]
});
const records = () => documents.filter(d => d.kind === "record").map(d => d.record);

test("v1 lost acknowledgements and concurrent duplicate deliveries commit one atomic groceries capture", async t => {
  const f = await fixture(t);
  faults.loseBatchResponse = true;
  assert.equal((await f.post(capture)).status, 503);
  assert.equal(records().length, 4);
  const attempts = await Promise.all([f.post(capture), f.post(capture), f.post(capture)]);
  assert.ok(attempts.every(result => result.status === 200));
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(records().length, 4);
  assert.equal(documents.filter(d => d.kind === "receipt").length, 1);
  assert.equal(attempts[0].body.sequence, 1);
  assert.equal((await f.get("item", "milk")).body.record.originalText, "  milk\n");
  const receipt = await f.request("receipts?accountId=alice&operationId=groceries-capture-1");
  assert.deepEqual(receipt.body, attempts[0].body);
  const changed = structuredClone(capture);
  changed.mutations[1].fields.title = "Different milk";
  assert.equal((await f.post(changed)).body.error, "operation_reused");
  const reordered = Object.fromEntries(Object.entries(capture).reverse());
  assert.deepEqual((await f.post(reordered)).body, receipt.body);
});

test("v1 rolls back failure at every batch position; retry creates each intended record exactly once", async t => {
  const f = await fixture(t);
  // State + four records + receipt + change entry.
  for (let i = 0; i < 7; i++) {
    documents.length = 0;
    faults.batchIndex = i;
    assert.equal((await f.post(capture)).status, 503);
    assert.equal(documents.length, 0, `no partial commit at operation ${i}`);
    assert.equal((await f.post(capture)).status, 200);
    assert.equal(records().length, 4);
  }
  documents.length = 0;
  const duplicates = await Promise.all([f.post(capture), f.post(capture)]);
  assert.deepEqual(duplicates[0], duplicates[1]);
  assert.equal(records().length, 4);
});

test("v1 explicit completion is repeat-safe, conflicts preserve drafts, and resolution uses the observed version", async t => {
  const f = await fixture(t);
  await f.post(capture);
  const complete = edit("complete-milk", "milk", 1, { status: "completed" });
  const first = await f.post(complete);
  assert.equal(first.status, 200);
  assert.deepEqual(await f.post(complete), first);
  assert.equal((await f.get("item", "milk")).body.record.status, "completed");
  const [a, b] = await Promise.all([
    f.post(edit("phone-edit", "milk", 2, { description: "Phone draft" })),
    f.post(edit("desktop-edit", "milk", 2, { description: "Desktop draft" }))
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const conflict = a.status === 409 ? a.body : b.body;
  const winner = a.status === 200 ? a.body : b.body;
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflicts[0].current.version, 3);
  assert.notEqual(conflict.conflicts[0].proposed.fields.description, winner.records[0].description);
  const persisted = await f.request(`receipts?accountId=alice&operationId=${conflict.operationId}`);
  assert.deepEqual(persisted.body, conflict);
  const resolved = await f.post(edit("resolve-edit", "milk", 3, { description: "Phone draft + Desktop draft", status: "next" }));
  assert.equal(resolved.body.records[0].version, 4);
  assert.equal(resolved.body.records[0].completedUtc, null);
  assert.equal(resolved.body.records[0].originalText, "  milk\n");
});

test("v1 moves keep identity, list deletion requires empty membership, and tombstones prevent stale resurrection", async t => {
  const f = await fixture(t);
  await f.post(capture);
  assert.equal((await f.post(edit("delete-full-list", "groceries", 1, undefined, "delete", "list"))).body.error, "list_not_empty");
  const move = await f.post(edit("move-milk", "milk", 1, { listId: null }));
  assert.equal(move.status, 200);
  assert.equal(move.body.records[0].id, "milk");
  assert.equal(records().filter(r => r.id === "milk").length, 1);
  const tombstone = await f.post(edit("delete-milk", "milk", 2, undefined, "delete"));
  assert.equal(tombstone.body.records[0].deleted, true);
  for (const operation of [edit("stale-milk", "milk", 2, { title: "Offline draft" }),
    edit("resurrect-milk", "milk", 0, { title: "New milk" }, "create"),
    edit("edit-tombstone", "milk", 3, { title: "Tombstone edit" })]) {
    const result = await f.post(operation);
    assert.equal(result.status, 409);
    assert.equal(result.body.conflicts[0].current.deleted, true);
  }
  assert.equal((await f.get("item", "milk")).body.record.version, 3);
  await f.post(edit("delete-bread", "bread", 1, undefined, "delete"));
  await f.post(edit("delete-eggs", "eggs", 1, undefined, "delete"));
  assert.equal((await f.post(edit("delete-empty-list", "groceries", 1, undefined, "delete", "list"))).status, 200);
  assert.equal((await f.post(edit("foreign-destination", "new-item", 0, { title: "Draft", listId: "groceries" }, "create"))).status, 404);
});

test("v1 account-bound queues and all read paths isolate users, expired sessions and origin failures write nothing", async t => {
  const f = await fixture(t);
  await f.post(capture);
  const before = structuredClone(documents);
  assert.equal((await f.post(capture, { user: "bob" })).body.error, "account_mismatch");
  assert.equal((await f.post(capture, { user: null })).status, 401);
  assert.equal((await f.post(capture, { origin: "https://evil.example" })).status, 403);
  for (const path of ["records?type=item&id=milk", "receipts?operationId=groceries-capture-1", "changes?after=0"]) {
    assert.equal((await f.request(`${path}&accountId=alice`, { user: "bob" })).status, 409);
    const own = await f.request(`${path}&accountId=bob`, { user: "bob" });
    assert.equal(own.status, path.startsWith("changes") ? 200 : 404);
    assert.doesNotMatch(JSON.stringify(own.body), /Milk|milk\n|Phone draft/);
  }
  const foreign = { ...edit("bob-item", "bob-item", 0, { title: "Bob", listId: "groceries" }, "create"), accountId: "bob" };
  assert.equal((await f.post(foreign, { user: "bob" })).status, 404);
  assert.deepEqual(documents, before);
  const bobCapture = { ...structuredClone(capture), accountId: "bob" };
  assert.equal((await f.post(bobCapture, { user: "bob" })).status, 200, "same client IDs are scoped to their account");
  assert.equal((await f.get("item", "milk", "bob")).body.record.accountId, "bob");
  assert.equal((await f.request("session", { user: "bob" })).body.accountId, "bob");
});

test("v1 change pages resume in numeric commit order during writes, include conflicts/deletes, and never skip gaps", async t => {
  const f = await fixture(t);
  await f.post(capture);
  for (let i = 1; i <= 12; i++) assert.equal((await f.post(edit(`edit-${i}`, "milk", i, { title: `Milk ${i}` }))).status, 200);
  await f.post(edit("stale", "milk", 1, { title: "Stale draft" }));
  await f.post(edit("delete", "milk", 13, undefined, "delete"));
  let after = 0;
  const entries = [];
  do {
    const result = await f.request(`changes?accountId=alice&after=${after}&limit=2`);
    assert.equal(result.status, 200);
    assert.ok(result.body.entries.length <= 2);
    entries.push(...result.body.entries);
    after = result.body.nextAfter;
    if (after === 2) await f.post(edit("concurrent-capture", "new", 0, { title: "Arrived while paging" }, "create"));
    if (!result.body.hasMore) break;
  } while (after < 100);
  assert.deepEqual(entries.map(e => e.sequence), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.equal(entries[13].status, "conflict");
  assert.equal(entries[14].records[0].deleted, true);
  assert.equal((await f.request("changes?accountId=alice&after=16")).body.entries.length, 0);
  assert.equal((await f.request("changes?accountId=alice&after=17")).body.error, "cursor_ahead");
  documents.splice(documents.findIndex(d => d.kind === "change" && d.sequence === 5), 1);
  assert.equal((await f.request("changes?accountId=alice&after=4")).body.error, "history_gap");
});

test("v1 validates its versioned contract and size bounds without mutating storage", async t => {
  const f = await fixture(t);
  const invalid = [
    { ...capture, apiVersion: 2 }, { ...capture, userId: "bob" }, { ...capture, operationId: "../bad" },
    { ...capture, mutations: [] }, { ...capture, mutations: Array(21).fill(capture.mutations[0]) },
    edit("bad", "milk", -1, { title: "bad" }), edit("bad", "milk", 0, { title: "x".repeat(201) }, "create"),
    edit("bad", "milk", 0, { title: "valid", status: "bogus" }, "create"),
    edit("bad", "milk", 0, { title: "valid", dueDateUtc: "2026-02-30T00:00:00Z" }, "create"),
    edit("bad", "milk", 0, { title: "valid", sourceUrl: "javascript:alert(1)" }, "create"),
    edit("bad", "milk", 0, { title: "valid", UserID: "bob" }, "create"),
    edit("bad", "milk", 1, { originalText: "overwrite original" }), edit("bad", "milk", 1, {}),
    edit("bad", "milk", 1, { title: "not allowed" }, "delete")
  ];
  for (const input of invalid) assert.equal((await f.post(input)).status, 400, JSON.stringify(input).slice(0, 200));
  assert.equal((await f.request("operations", { raw: "{" })).status, 400);
  assert.equal((await f.request("operations", { raw: "x".repeat(65537) })).status, 413);
  assert.equal((await f.post(capture, { headers: { "content-type": "text/plain" } })).status, 415);
  for (const query of ["limit=0", "limit=51", "after=-1", "after=1.5", "after=9007199254740992"]) {
    assert.equal((await f.request(`changes?accountId=alice&${query}`)).status, 400);
  }
  assert.equal(documents.length, 0);
  process.env.V1_API_ENABLED = "false";
  try { assert.equal((await f.post(capture)).body.error, "v1_disabled"); }
  finally { process.env.V1_API_ENABLED = "true"; }
});

test("v1 a rejected multi-record edit preserves every proposed draft, even after a lost conflict response", async t => {
  const f = await fixture(t);
  await f.post(capture);
  await f.post(edit("milk-first-edit", "milk", 1, { title: "Updated milk" }));
  const input = edit("mixed-conflict", "milk", 1, { title: "Offline milk draft" });
  input.mutations.push({ type: "item", id: "bread", action: "update", expectedVersion: 1, fields: { title: "Offline bread draft" } });
  faults.loseBatchResponse = true;
  assert.equal((await f.post(input)).status, 503);
  const conflict = await f.post(input);
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.proposed, input.mutations);
  assert.equal(conflict.body.conflicts.length, 1);
  assert.equal((await f.get("item", "bread")).body.record.title, "Bread");
  assert.deepEqual((await f.request("receipts?accountId=alice&operationId=mixed-conflict")).body, conflict.body);
});

test("v1 concurrent list deletion and item capture cannot leave a dangling relationship", async t => {
  const f = await fixture(t);
  await f.post(edit("empty-list", "empty", 0, { title: "Empty" }, "create", "list"));
  const results = await Promise.all([
    f.post(edit("delete-empty", "empty", 1, undefined, "delete", "list")),
    f.post(edit("capture-race", "new-item", 0, { title: "Arriving item", listId: "empty" }, "create"))
  ]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  const list = (await f.get("list", "empty")).body.record;
  const item = await f.get("item", "new-item");
  assert.equal(list.deleted, item.status === 404);
});

test("v1 byte-bounded pages resume without dropping a large entry; oversized resulting records are rejected", async t => {
  const f = await fixture(t);
  const large = edit("large-capture", "large", 0, { title: "Large capture", originalText: "a".repeat(16000),
    selectedText: "b".repeat(8000), sourceTitle: "c".repeat(2000), description: "d".repeat(4000) }, "create");
  assert.equal((await f.post(large)).status, 200);
  const tooLarge = await f.post(edit("oversize-edit", "large", 1, { waitingOn: "e".repeat(4000) }));
  assert.equal(tooLarge.status, 400);
  assert.equal((await f.get("item", "large")).body.record.version, 1);
  for (let i = 1; i <= 40; i++) assert.equal((await f.post(edit(`large-edit-${i}`, "large", i, { title: `Large ${i}` }))).status, 200);
  const first = (await f.request("changes?accountId=alice&limit=50")).body;
  assert.equal(first.hasMore, true);
  assert.ok(first.entries.length < 41);
  assert.ok(Buffer.byteLength(JSON.stringify(first.entries)) < 1000100);
  const second = (await f.request(`changes?accountId=alice&after=${first.nextAfter}&limit=50`)).body;
  assert.equal(second.hasMore, false);
  assert.deepEqual([...first.entries, ...second.entries].map(e => e.sequence), Array.from({ length: 41 }, (_, i) => i + 1));
  assert.ok(documents.every(d => d.ttl === -1), "container TTL cannot silently expire receipts/history/tombstones");
});
