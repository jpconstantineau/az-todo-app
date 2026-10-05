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
  "v1/operations": capture,
  "shared/operations": { accountId: 'alice', listId: 'shared-fixture', operationId: 'create-shared', expectedRevision: 0, action: 'create', fields: { title: 'Shared groceries' } }
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
      const json = path.startsWith("v1/") || path.startsWith("shared/");
      if (json && data) requestHeaders.set("content-type", "application/json");
      const response = await fetch(`${server.url}/api/${path}`, {
        method, headers: requestHeaders, body: body ?? (data ? json ? JSON.stringify(data) : new URLSearchParams(data) : undefined)
      });
      assertHeaders(response);
      return { status: response.status, html: await response.text() };
    }
  };
}

test("every mutation rejects untrusted browser origins without writing and accepts current writes without depending on HX-Request", async t => {
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
      assert.equal((await f.request(path, { data, headers })).status, 200, path);
    }
    seed();
    assert.equal((await f.request(path, { data, origin: null, headers: { referer: f.url + "/page" } })).status, 200, `${path}: Referer fallback`);
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

test("all routes require an authenticated principal", async t => {
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
      assert.equal(response.status, 401, path);
    }
  }
  assert.deepEqual(documents, before);
});

test("all read routes isolate accounts and never initialize data", async t => {
  const f = await fixture(t); seed();
  const reads = {
    "v1/session": "v1/session", "v1/records": "v1/records?accountId=alice&type=item&id=alice-item",
    "v1/receipts": "v1/receipts?accountId=alice&operationId=seed", "v1/changes": "v1/changes?accountId=alice",
    "v1/export": "v1/export?accountId=alice", health: "health", "shared/lists": "shared/lists"
  };
  const before = structuredClone(documents);
  for (const route of routes.keys()) {
    if (!route.startsWith("GET ")) continue;
    const path = route.slice(9), active = reads[path];
    const response = await f.request(active || path);
    assert.equal(response.status, active ? 200 : 400, path);
    assert.doesNotMatch(response.html, /bob-private/);
    if (active?.includes('accountId=')) assert.equal((await f.request(active, { user: 'bob' })).status, 409);
  }
  assert.deepEqual(documents, before);
  documents.length = 0;
  assert.equal((await f.request('v1/session')).status, 200);
  assert.equal(documents.length, 0);
});

test("production routes cannot bypass the shared HTTP registration guard", async () => {
  const root = new URL("../api/", import.meta.url);
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith(".mjs") || file.replaceAll("\\", "/") === "shared/http.mjs") continue;
    assert.doesNotMatch(await readFile(new URL(file.replaceAll("\\", "/"), root), "utf8"), /from\s+["']@azure\/functions["']/, file);
  }
});
