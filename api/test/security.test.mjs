import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { documents, faults, routes, startServer } from "./harness.mjs";
import { defaultSettings } from "../api/shared/defaults.mjs";
import { checkCsrf } from "../api/shared/security.mjs";
import { document, recordId } from "../api/v1/contract.mjs";
import capture from "./fixtures/v1-operations.json" with { type: "json" };

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");
const principal = userId => encode({ userId, userRoles: ["anonymous", "authenticated"] });
function seed() {
  documents.length = 0;
  for (const userId of ["alice", "bob"]) {
    const common = { UserID: userId, userId, createdUtc: "2026-10-01T00:00:00Z", updatedUtc: "2026-10-01T00:00:00Z" };
    documents.push(
      { ...common, id: `${userId}-list`, listId: `${userId}-list`, ObjectID: `${userId}-list`, ObjectType: "list", title: `${userId}-private-list`, defaults: structuredClone(defaultSettings) },
      { ...common, id: `${userId}-item`, listId: `${userId}-list`, ObjectID: `${userId}-list`, ObjectType: "item", title: `${userId}-private-item`, status: "next" },
      { ...common, id: "settings", ObjectID: "_meta", ObjectType: "userSettings", defaults: { ...structuredClone(defaultSettings), contexts: [`${userId}-private-context`] } }
    );
    documents.push(
      document(userId, recordId("item", `${userId}-item`), { kind: "record", record: { id: `${userId}-item`, title: `${userId}-private-item`, accountId: userId } }),
      document(userId, "receipt:seed", { kind: "receipt", response: { accountId: userId, title: `${userId}-private-receipt` } })
    );
  }
}
const mutationCases = {
  "lists/create": { title: "New list" },
  "items/create": { title: "New item", listId: "alice-list" },
  "items/toggleComplete": { id: "alice-item", listId: "alice-list" },
  "lists/updateDefaults": { listId: "alice-list", "statuses[]": "next\nwaiting" },
  "lists/resetDefaults": { listId: "alice-list" },
  "settings/update": { "contexts[]": "@Home" },
  "settings/reset": {},
  "settings/ensure": {},
  "v1/operations": capture
};
function assertHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
}
async function fixture(t) {
  const server = await startServer();
  t.after(server.close);
  return {
    ...server,
    async request(path, { data, user = "alice", headers = {}, method = data ? "POST" : "GET", origin = server.url, body } = {}) {
      const requestHeaders = new Headers({ ...(user ? { "x-ms-client-principal": principal(user) } : {}), ...headers });
      if (origin !== null) requestHeaders.set("origin", origin);
      if (path.startsWith("v1/") && data) requestHeaders.set("content-type", "application/json");
      const response = await fetch(`${server.url}/api/${path}`, {
        method, headers: requestHeaders, body: body ?? (data ? path.startsWith("v1/") ? JSON.stringify(data) : new URLSearchParams(data) : undefined)
      });
      assertHeaders(response);
      return { status: response.status, html: await response.text() };
    }
  };
}

test("every mutation rejects untrusted browser origins without writing, and accepts legitimate forms without HX-Request", async t => {
  const f = await fixture(t);
  assert.deepEqual([...routes.keys()].filter(key => !key.startsWith("GET ")).sort(),
    Object.keys(mutationCases).map(path => `POST /api/${path}`).sort(), "add a valid fixture for every new mutation");
  const invalid = [
    { origin: null }, { origin: "null" }, { origin: "https://foreign.example" },
    { origin: `${f.url}.evil.example` }, { origin: `${f.url}/path` },
    { origin: `${f.url}/` }, { origin: `${f.url}, https://foreign.example` },
    { origin: "https://user:password@foreign.example" }, { origin: "not a URL" },
    { headers: { referer: "https://foreign.example/page" } },
    { headers: { referer: "malformed" } },
    { origin: null, headers: { referer: f.url.replace("http://", "http:") } },
    { headers: { referer: `${f.url}/#fragment` } },
    { origin: "https://foreign.example", headers: { referer: f.url + "/" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { "sec-fetch-site": "same-site" } },
    { origin: null, headers: { "HX-Request": "true", "x-forwarded-host": "foreign.example" } }
  ];
  for (const [path, data] of Object.entries(mutationCases)) {
    for (const attempt of invalid) {
      seed();
      const before = structuredClone(documents);
      assert.equal((await f.request(path, { data, ...attempt })).status, 403, `${path}: ${JSON.stringify(attempt)}`);
      assert.deepEqual(documents, before);
    }
    for (const headers of [{}, { referer: f.url + "/page?view=tasks", "sec-fetch-site": "same-origin" }]) {
      seed();
      assert.ok((await f.request(path, { data, headers })).status < 300, path);
    }
    seed();
    assert.ok((await f.request(path, { data, origin: null, headers: { referer: f.url + "/page" } })).status < 300, `${path}: Referer fallback`);
  }
});

test("explicit origin configuration rejects lookalikes, malformed entries and conflicts even between allowed origins", () => {
  const previous = process.env.APP_ORIGIN;
  try {
    process.env.APP_ORIGIN = "https://todo.example,https://preview.example";
    const request = headers => ({ url: "https://internal-backend.example/api/items/create", headers: new Headers(headers) });
    assert.equal(checkCsrf(request({ origin: "https://todo.example" })), true);
    for (const origin of ["https://todo.example.evil.test", "https://todo.example@evil.test", "https://todo.example:444", "http://todo.example", "https://todo.example\\@evil.test", "https://todo.example#fragment"]) {
      assert.equal(checkCsrf(request({ origin })), false, origin);
    }
    assert.equal(checkCsrf(request({ origin: "https://todo.example", referer: "https://preview.example/" })), false);
    for (const config of ["", "https://todo.example,", "https://todo.example/path", "https://todo.example,not-a-url"]) {
      process.env.APP_ORIGIN = config;
      assert.equal(checkCsrf(request({ origin: "https://todo.example" })), false);
    }
  } finally {
    if (previous === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previous;
  }
});

test("all routes require an authenticated principal except the read-only sign-in shell", async t => {
  const f = await fixture(t);
  const invalid = [null, "not-base64!", encode(null), encode({ userId: "alice" }),
    encode({ userId: 123, userRoles: ["authenticated"] }),
    encode({ userId: "alice", userRoles: ["anonymous"] }),
    encode({ userId: "alice", userRoles: "authenticated" }),
    encode({ userId: " ", userRoles: ["authenticated"] })];
  seed();
  const before = structuredClone(documents);
  for (const key of routes.keys()) {
    const [method, url] = key.split(" ");
    const path = url.slice(5);
    for (const value of invalid) {
      const response = await f.request(path, { user: null, method, data: method === "POST" ? {} : undefined,
        headers: value === null ? { "HX-Request": "true" } : { "x-ms-client-principal": value } });
      assert.equal(response.status, path === "app" ? 200 : 401, path);
      if (path === "app") assert.match(response.html, /sign in/);
    }
  }
  assert.deepEqual(documents, before);
});

test("two accounts cannot read or mutate foreign records; owner fields never choose the account", async t => {
  const f = await fixture(t);
  seed();
  const reads = {
    app: "app", "lists/all": "lists/all", "items/byList": "items/byList?listId=alice-list",
    "lists/defaultOptions": "lists/defaultOptions?listId=alice-list",
    "lists/editDefaults": "lists/editDefaults?listId=alice-list",
    "lists/quickAddForm": "lists/quickAddForm?listId=alice-list",
    "items/filterByStatus": "items/filterByStatus?status=next", "settings/edit": "settings/edit", health: "health",
    "v1/session": "v1/session", "v1/records": "v1/records?accountId=alice&type=item&id=alice-item",
    "v1/receipts": "v1/receipts?accountId=alice&operationId=seed", "v1/changes": "v1/changes?accountId=alice"
  };
  assert.deepEqual([...routes.keys()].filter(key => key.startsWith("GET ")).sort(),
    Object.keys(reads).map(path => `GET /api/${path}`).sort(), "add isolation coverage for each new read route");
  const before = structuredClone(documents);
  for (const path of Object.values(reads)) {
    const response = await f.request(path);
    assert.equal(response.status, 200, path);
    assert.doesNotMatch(response.html, /bob-private/);
    const bobResponse = await f.request(path.replaceAll("alice", "bob"), { user: "bob" });
    assert.equal(bobResponse.status, 200, path);
    assert.doesNotMatch(bobResponse.html, /alice-private/);
    if (path.includes("listId=")) {
      assert.equal((await f.request(path.replace("alice-list", "bob-list"))).status, 404, path);
      assert.equal((await f.request(path.replace("alice-list", "unknown"))).status, 404, path);
      assert.equal((await f.request(path, { user: "bob" })).status, 404, path);
    }
  }
  assert.deepEqual(documents, before, "GET routes never write");
  for (const path of ["items/create", "items/toggleComplete", "lists/updateDefaults", "lists/resetDefaults"]) {
    const data = { ...mutationCases[path], listId: "bob-list", id: "bob-item", UserID: "bob", userId: "bob" };
    assert.equal((await f.request(path, { data })).status, 404, path);
    assert.deepEqual(documents, before);
  }
  assert.equal((await f.request("items/toggleComplete", { data: { id: "bob-item", listId: "alice-list" } })).status, 404);
  for (const [path, data] of Object.entries(mutationCases)) {
    seed();
    const bob = structuredClone(documents.filter(doc => doc.UserID === "bob"));
    const forged = await f.request(path, { data: { ...data, userId: "bob", UserID: "bob", ObjectID: "bob-list", ObjectType: "list" } });
    assert.ok(path.startsWith("v1/") ? forged.status === 400 : forged.status < 300, path);
    assert.deepEqual(documents.filter(doc => doc.UserID === "bob"), bob, path);
    assert.ok(documents.every(doc => doc.ObjectType === "sync" || doc.userId === doc.UserID));
  }
  documents.length = 0;
  assert.equal((await f.request("app")).status, 200);
  assert.equal(documents.length, 0, "first page load does not create settings");
  assert.equal((await f.request("settings/ensure", { data: {} })).status, 201);
  assert.equal((await f.request("settings/ensure", { data: {} })).status, 200);
});

test("invalid inputs fail with field errors before writes, without clipping; failures retain cache protections", async t => {
  const f = await fixture(t);
  seed();
  const cases = [
    ["lists/create", { title: "x".repeat(201) }, /Title/],
    ["lists/create", { title: "valid", description: "x".repeat(4001) }, /Description/],
    ["items/create", { status: "not-configured" }, /Status/],
    ...["title", "description", "status", "context", "area", "energy", "timeRequired", "priority", "listId"].map(field =>
      ["items/create", { [field]: "x".repeat((({ title: 200, description: 4000, listId: 200 })[field] ?? 64) + 1) }, /at most/]),
    ["items/create", { dueDateUtc: "2026-02-30T00:00:00Z" }, /valid due date/],
    ["items/create", { dueDateUtc: "tomorrowZ" }, /valid due date/],
    ["items/create", { context: "@Home\u0000" }, /control characters/],
    ["items/create", { context: "@Home\n@Work" }, /single line/],
    ["items/toggleComplete", { id: "x".repeat(201) }, /id/],
    ["lists/resetDefaults", { listId: "x".repeat(201) }, /listId/],
    ...["settings/update", "lists/updateDefaults"].flatMap(path => [
      [path, { "contexts[]": "x".repeat(65) }, /contexts/],
      [path, { "statuses[]": "x".repeat(65) }, /statuses/],
      [path, { "areas[]": Array.from({ length: 201 }, (_, i) => `area${i}`).join("\n") }, /200 options/]
    ])
  ];
  for (const [path, invalid, message] of cases) {
    const before = structuredClone(documents);
    const response = await f.request(path, { data: { ...mutationCases[path], ...invalid } });
    assert.equal(response.status, 400, `${path}: ${Object.keys(invalid)}`);
    assert.match(response.html, message);
    assert.deepEqual(documents, before);
  }
  const invalidForm = await f.request("items/create", { method: "POST", body: "not a form", headers: { "content-type": "application/json" } });
  assert.equal(invalidForm.status, 400);
  assert.match(invalidForm.html, /valid form/);
  const upload = new FormData();
  upload.set("title", new Blob(["binary title"]), "title.txt");
  assert.equal((await f.request("lists/create", { method: "POST", body: upload })).status, 400);

  const customStatus = "s".repeat(64);
  assert.equal((await f.request("lists/updateDefaults", { data: { listId: "alice-list", "statuses[]": customStatus } })).status, 200);
  assert.equal((await f.request("items/create", { data: { ...mutationCases["items/create"], status: customStatus } })).status, 200);
  assert.equal(documents.at(-1).status, customStatus);
  assert.equal((await f.request("items/create", { data: { ...mutationCases["items/create"], dueDateUtc: "2026-10-03T18:30:00Z" } })).status, 200);
  for (const path of ["items/create", "settings/reset"]) {
    const before = structuredClone(documents);
    faults.nextWrite = true;
    assert.equal((await f.request(path, { data: mutationCases[path] })).status, 500);
    assert.deepEqual(documents, before);
  }
});

test("production routes cannot bypass the shared HTTP registration guard", async () => {
  const root = new URL("../api/", import.meta.url);
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith(".mjs") || file.replaceAll("\\", "/") === "shared/http.mjs") continue;
    assert.doesNotMatch(await readFile(new URL(file.replaceAll("\\", "/"), root), "utf8"), /from\s+["']@azure\/functions["']/, file);
  }
});
