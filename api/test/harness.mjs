import { mock } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import functions from "@azure/functions";
const { app, HttpRequest, HttpResponse } = functions;

// Only storage and function registration are replaced. The production entry point,
// handlers, auth parsing, validation and Azure HTTP types execute as-is.
export const documents = [];
export const routes = new Map();
export const faults = { nextWrite: false, batchIndex: -1, loseBatchResponse: false };
let etag = 0;
process.env.V1_API_ENABLED = "true";
const clone = value => structuredClone(value);
function failWrite() {
  if (faults.nextWrite) { faults.nextWrite = false; throw new Error("Injected storage failure"); }
}
const container = {
  items: {
    async batch(operations, partition) {
      failWrite();
      const staged = clone(documents);
      const result = [];
      for (const [i, operation] of operations.entries()) {
        const doc = operation.resourceBody;
        const index = staged.findIndex(d => d.id === (operation.id ?? doc.id) && [d.UserID, d.ObjectType, d.ObjectID].every((v, j) => v === partition[j]));
        let code = i === faults.batchIndex ? 503 : 200;
        if (operation.operationType === "Create" && index >= 0) code = 409;
        if (operation.operationType === "Replace" && (index < 0 || staged[index]._etag !== operation.ifMatch)) code = 412;
        if (!["Create", "Replace"].includes(operation.operationType)) throw new Error("Unsupported mock batch operation");
        assertPartition(doc, partition);
        if (code !== 200) {
          faults.batchIndex = -1;
          return { code, result: operations.map((_, j) => ({ statusCode: i === j ? code : 424 })) };
        }
        const saved = { ...clone(doc), _etag: String(++etag) };
        if (index < 0) staged.push(saved); else staged[index] = saved;
        result.push({ statusCode: operation.operationType === "Create" ? 201 : 200 });
      }
      documents.splice(0, documents.length, ...staged);
      if (faults.loseBatchResponse) { faults.loseBatchResponse = false; throw new Error("Injected lost acknowledgement"); }
      return { code: 200, result };
    },
    async create(doc) {
      failWrite();
      if (documents.some(d => d.id === doc.id && d.UserID === doc.UserID && d.ObjectType === doc.ObjectType && d.ObjectID === doc.ObjectID)) throw new Error("Conflict");
      documents.push(clone(doc));
      return { resource: clone(doc) };
    },
    query({ query, parameters }, config = {}) {
      const params = Object.fromEntries(parameters.map(p => [p.name, p.value]));
      const property = (doc, key) => key.split(".").reduce((value, part) => value?.[part], doc);
      let rows = documents.filter(doc => [...query.matchAll(/c\.([\w.]+)\s*(=|<=|>)\s*(@\w+|'[^']*'|false)/g)].every(([, key, op, literal]) => {
        const actual = property(doc, key);
        const value = literal.startsWith("@") ? params[literal] : literal === "false" ? false : literal.slice(1, -1);
        return op === "=" ? actual === value : op === ">" ? actual > value : actual <= value;
      }));
      if (query.includes('ARRAY_CONTAINS(c.record.collectionRefs')) rows = documents.filter(doc => doc.UserID === params['@u'] && doc.ObjectType === 'sync' && doc.ObjectID === 'v1' && doc.kind === 'record' && !doc.record.deleted &&
        (doc.record.collectionRefs?.some(ref => ref.type === params['@type'] && ref.id === params['@l']) ||
         !doc.record.collectionRefs && doc.record[params['@type'] + 'Id'] === params['@l'] ||
         doc.record.parentRef?.type === params['@type'] && doc.record.parentRef.id === params['@l']));
      if (query.includes('ARRAY_CONTAINS(c.members')) rows = documents.filter(doc => doc.kind === 'shared-list' &&
        (doc.ownerId === params['@u'] || !doc.deleted && doc.members.some(member => member.accountId === params['@u'])));
      if (config.partitionKey) rows = rows.filter(d => [d.UserID, d.ObjectType, d.ObjectID].every((v, i) => v === config.partitionKey[i]));
      const order = query.match(/ORDER BY c\.(\w+) (ASC|DESC)/);
      if (order) rows.sort((a, b) => (typeof a[order[1]] === "number" ? a[order[1]] - b[order[1]] : String(a[order[1]] || "").localeCompare(String(b[order[1]] || ""))) * (order[2] === "DESC" ? -1 : 1));
      const top = query.match(/SELECT TOP (\d+)/);
      if (top) rows = rows.slice(0, Number(top[1]));
      const projection = query.match(/^SELECT (?:TOP \d+ )?(c\.[\w., ]+) FROM/);
      if (projection) rows = rows.map(doc => Object.fromEntries(projection[1].split(",").map(key => { key = key.trim().slice(2); return [key, doc[key]]; })));
      return {
        async fetchAll() { return { resources: clone(rows) }; },
        async fetchNext() {
          const start = Number(config.continuationToken || 0);
          const end = start + config.maxItemCount;
          return { resources: clone(rows.slice(start, end)), continuationToken: end < rows.length ? String(end) : undefined };
        }
      };
    }
  },
  item(id, partition) {
    return { async read() {
      const doc = documents.find(d => d.id === id && [d.UserID, d.ObjectType, d.ObjectID].every((v, i) => v === partition[i]));
      if (!doc) throw Object.assign(new Error("Not found"), { code: 404 });
      return { resource: clone(doc) };
    }, async replace(doc) {
      failWrite();
      const index = documents.findIndex(d => d.id === id && [d.UserID, d.ObjectType, d.ObjectID].every((v, i) => v === partition[i]));
      if (index < 0) throw Object.assign(new Error("Not found"), { code: 404 });
      documents[index] = clone(doc);
      return { resource: clone(doc) };
    } };
  }
};
function assertPartition(doc, partition) {
  if (![doc.UserID, doc.ObjectType, doc.ObjectID].every((value, i) => value === partition[i])) throw new Error("Wrong batch partition");
}
mock.module("../api/shared/db.mjs", { namedExports: { container } });
app.http = (name, config) => {
  for (const method of config.methods) routes.set(`${method} /api/${config.route}`, config.handler);
};
await import("../api/index.mjs");

export async function startServer({ browserUser = false, assetContents = () => undefined, rejectOperations = () => false } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      // Server-side faults also cover requests made through an active service worker.
      if (req.method === 'POST' && url.pathname === '/api/v1/operations' && rejectOperations()) {
        req.resume();
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'private, no-store' });
        res.end(JSON.stringify({ apiVersion: 1, error: 'storage_unavailable', message: 'Injected operations outage.' }));
        return;
      }
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (handler) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = { ...req.headers };
        if (browserUser) {
          const user = typeof browserUser === 'function' ? browserUser() : 'disposable-test-user';
          delete headers['x-ms-client-principal'];
          if (user) headers['x-ms-client-principal'] = Buffer.from(JSON.stringify({ userId: user, userRoles: ['authenticated'] })).toString('base64');
        }
        const request = new HttpRequest({ method: req.method, url: `http://${req.headers.host}${req.url}`, headers,
          body: chunks.length ? { bytes: Buffer.concat(chunks) } : undefined });
        const result = new HttpResponse(await handler(request));
        res.writeHead(result.status, Object.fromEntries(result.headers));
        res.end(await result.text());
      } else {
        const assets = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"], "/styles.css": ["styles.css", "text/css"] };
        for (const name of ['collection-model.js', 'collections.js', 'shared.html', 'shared.js', 'shared.css', 'capture-extraction.js', 'workspaces.js', 'handoff.html', 'handoff.js', 'handoff-protocol.js', 'theme.js', 'pwa.js', 'help.html', 'inbox.html', 'inbox.css', 'inbox.js', 'inbox-store.js', 'inbox-fields.js', 'inbox-export.js', 'reviews.js', 'clarification.js', 'local-guidance.js', 'local-agent.js', 'briefs.js', 'inbox-sw.js']) {
          assets[`/${name}`] = [name, name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript'];
        }
        assets["/manifest.json"] = ["manifest.json", "application/json"];
        for (const name of ["icon-192.png", "icon-512.png", "apple-touch-icon.png"]) assets["/icons/" + name] = ["icons/" + name, "image/png"];
        assets['/clarification-flow.js'] = ['clarification-flow.js', 'text/javascript'];
        const asset = assets[url.pathname];
        if (!asset) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "content-type": asset[1] });
        res.end(assetContents(url.pathname) ?? await readFile(new URL(`../../html/${asset[0]}`, import.meta.url)));
      }
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Server error");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
export const principal = Buffer.from(JSON.stringify({ userId: "disposable-test-user", userRoles: ["authenticated"] })).toString("base64");
