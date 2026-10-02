import { mock } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { app, HttpRequest, HttpResponse } from "@azure/functions";

// Only storage and function registration are replaced. The production entry point,
// handlers, auth parsing, validation, templates and Azure HTTP types execute as-is.
export const documents = [];
export const routes = new Map();
export const faults = { nextWrite: false };
const clone = value => structuredClone(value);
function failWrite() {
  if (faults.nextWrite) { faults.nextWrite = false; throw new Error("Injected storage failure"); }
}
const container = {
  items: {
    async create(doc) {
      failWrite();
      if (documents.some(d => d.id === doc.id && d.UserID === doc.UserID && d.ObjectType === doc.ObjectType && d.ObjectID === doc.ObjectID)) throw new Error("Conflict");
      documents.push(clone(doc));
      return { resource: clone(doc) };
    },
    query({ query, parameters }, config = {}) {
      const params = Object.fromEntries(parameters.map(p => [p.name, p.value]));
      let rows = documents.filter(doc => [...query.matchAll(/c\.(\w+)\s*=\s*(@\w+|'[^']*')/g)].every(([, key, value]) => doc[key] === (value.startsWith("@") ? params[value] : value.slice(1, -1))));
      const order = query.match(/ORDER BY c\.(\w+) (ASC|DESC)/);
      if (order) rows.sort((a, b) => String(a[order[1]] || "").localeCompare(String(b[order[1]] || "")) * (order[2] === "DESC" ? -1 : 1));
      if (query.includes("TOP 1")) rows = rows.slice(0, 1);
      const projection = query.match(/^SELECT (c\.[\w., ]+) FROM/);
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
    return { async replace(doc) {
      failWrite();
      const index = documents.findIndex(d => d.id === id && [d.UserID, d.ObjectType, d.ObjectID].every((v, i) => v === partition[i]));
      if (index < 0) throw Object.assign(new Error("Not found"), { code: 404 });
      documents[index] = clone(doc);
      return { resource: clone(doc) };
    } };
  }
};
mock.module("../api/shared/db.mjs", { namedExports: { container } });
app.http = (name, config) => {
  for (const method of config.methods) routes.set(`${method} /api/${config.route}`, config.handler);
};
await import("../api/index.mjs");

export async function startServer({ browserUser = false } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (handler) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const headers = { ...req.headers };
        if (browserUser) headers["x-ms-client-principal"] = principal;
        const request = new HttpRequest({ method: req.method, url: `http://${req.headers.host}${req.url}`, headers,
          body: chunks.length ? { bytes: Buffer.concat(chunks) } : undefined });
        const result = new HttpResponse(await handler(request));
        res.writeHead(result.status, Object.fromEntries(result.headers));
        res.end(await result.text());
      } else {
        const assets = { "/": ["index.html", "text/html"], "/styles.css": ["styles.css", "text/css"], "/app.js": ["app.js", "text/javascript"] };
        const asset = assets[url.pathname];
        if (!asset) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "content-type": asset[1] });
        res.end(await readFile(new URL(`../../html/${asset[0]}`, import.meta.url)));
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
