import { test } from "node:test";
import assert from "node:assert/strict";
import { documents, faults, principal, routes, startServer } from "./harness.mjs";
import * as templates from "../api/shared/templates.mjs";
import { defaultSettings } from "../api/shared/defaults.mjs";

test("registered HTTP handlers: list, add, reload, complete/reopen, settings and validation", async t => {
  documents.length = 0;
  const server = await startServer();
  t.after(server.close);
  async function request(path, data, signedIn = true) {
    const headers = signedIn ? { "x-ms-client-principal": principal, "HX-Request": "true" } : {};
    const response = await fetch(server.url + "/api/" + path, { method: data ? "POST" : "GET", headers, body: data ? new URLSearchParams(data) : undefined });
    return { status: response.status, html: await response.text() };
  }
  assert.match((await request("app", null, false)).html, /\.auth\/login\/github/);
  assert.equal((await request("lists/all", null, false)).status, 401);
  assert.match((await request("app")).html, /No lists yet/);
  assert.equal((await request("lists/create", { title: "  " })).status, 400);
  const title = 'Groceries <script>alert("x")</script> & eggs';
  const description = 'Milk & bread\n<details>original</details>';
  const created = await request("lists/create", { title, description });
  assert.equal(created.status, 200);
  assert.ok(created.html.includes(templates.esc(title)));
  assert.ok(!created.html.includes("<script>"));
  const list = documents.find(d => d.ObjectType === "list");
  assert.equal(list.description, description);
  assert.match((await request("lists/all")).html, /items\/byList/);
  const empty = await request(`items/byList?listId=${list.id}`);
  assert.match(empty.html, /No items in this view/);
  assert.ok(empty.html.includes(templates.esc(description)));
  assert.equal((await request("items/create", { title: "missing list", listId: "missing" })).status, 404);
  assert.equal((await request("items/create", { title: "bad date", listId: list.id, dueDateUtc: "badZ" })).status, 400);
  assert.equal((await request("items/create", { title: "x".repeat(201), listId: list.id })).status, 400);
  const itemInput = { title: 'Buy <milk> & "bread"', description, listId: list.id, status: "waiting", dueDateUtc: "2026-10-03T18:30:00.000Z", context: "@Errands", area: "Personal", energy: "Low", timeRequired: "15m", priority: "P2" };
  assert.equal((await request("items/create", itemInput)).status, 200);
  let item = documents.find(d => d.ObjectType === "item");
  for (const field of ["title", "description", "listId", "status", "dueDateUtc", "energy", "timeRequired", "priority"]) assert.equal(item[field], itemInput[field]);
  assert.deepEqual(item.contexts, ["@Errands"]);
  assert.deepEqual(item.areas, ["Personal"]);
  const reloaded = await request(`items/byList?listId=${list.id}`);
  assert.ok(reloaded.html.includes(templates.esc(itemInput.title)));
  assert.match(reloaded.html, /2026-10-03T18:30:00.000Z/);
  const completed = await request("items/toggleComplete", { id: item.id, listId: list.id });
  assert.match(completed.html, /^<article/);
  assert.match(completed.html, />Reopen</);
  assert.ok(documents.find(d => d.id === item.id).completedUtc);
  assert.match((await request("items/toggleComplete", { id: item.id, listId: list.id })).html, />Complete</);
  item = documents.find(d => d.id === item.id);
  assert.equal(item.status, "waiting");
  assert.equal(item.completedUtc, null);
  const settings = { "contexts[]": "@Shop\n@Home", "areas[]": "Personal", "energy[]": "Low", "timeRequired[]": "5m", "priority[]": "P1", "statuses[]": "next\nwaiting" };
  assert.equal((await request("settings/update", settings)).status, 200);
  assert.match((await request("settings/edit")).html, /@Shop\n@Home/);
  assert.equal((await request("lists/updateDefaults", { ...settings, listId: list.id })).status, 200);
  assert.match((await request(`lists/defaultOptions?listId=${list.id}`)).html, /@Shop/);
  assert.match((await request(`lists/quickAddForm?listId=${list.id}`)).html, new RegExp(`value="${list.id}" selected`));
  assert.equal((await request("lists/resetDefaults", { listId: list.id })).status, 200);
  assert.equal((await request("settings/reset", {})).status, 200);
  faults.nextWrite = true;
  assert.equal((await request("items/create", itemInput)).status, 500);
  assert.equal(documents.filter(d => d.ObjectType === "item").length, 1);
  // More than one page: the next request replaces its own paging control.
  for (let i = 0; i < 51; i++) documents.push({ ...item, id: `page-${i}`, status: "next" });
  const first = await request("items/filterByStatus?status=next");
  assert.match(first.html, /closest \.load-more/);
  const second = await request("items/filterByStatus?status=next&ct=50");
  assert.equal((second.html.match(/<article/g) || []).length, 1);
  assert.ok(!second.html.includes('id="items"'));
});

test("empty/populated/adversarial templates only advertise registered method/route pairs", () => {
  const list = { id: 'id"<&', title: '<img src=x onerror="alert(1)">', description: "<&", defaults: defaultSettings };
  const item = { id: 'item"<', listId: list.id, title: list.title, description: list.description, status: "next", contexts: ["<&"] };
  const fragments = [templates.layoutShell(), templates.layoutShell({ lists: [list] }), templates.listView({ list, items: [item] }), templates.listSettingsForm({ list }), templates.settingsForm(), templates.itemsList(), templates.defaultOptions()];
  for (const html of fragments) {
    assert.doesNotMatch(html, /<!doctype|<html|<body|<script|<img/i);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, "no duplicate IDs in a fragment");
    for (const [, method, url] of html.matchAll(/hx-(get|post)="([^"]+)"/g)) {
      assert.ok(routes.has(`${method.toUpperCase()} ${url.split("?")[0]}`), `${method} ${url}`);
    }
    assert.doesNotMatch(html, />Delete</);
  }
});
