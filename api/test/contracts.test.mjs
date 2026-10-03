import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { documents, routes, startServer } from './harness.mjs';
import { retiredRoutes } from '../api/legacy.mjs';

test('all rollout flag combinations keep legacy writes retired and v1 gating explicit', async t => {
  const server = await startServer({ browserUser: true }); t.after(server.close);
  const api = process.env.V1_API_ENABLED, client = process.env.V1_CLIENT_ENABLED;
  const before = structuredClone(documents);
  try {
    for (const enabled of ['true', 'false', undefined]) for (const oldFlag of ['true', 'false', undefined]) {
      if (enabled === undefined) delete process.env.V1_API_ENABLED; else process.env.V1_API_ENABLED = enabled;
      if (oldFlag === undefined) delete process.env.V1_CLIENT_ENABLED; else process.env.V1_CLIENT_ENABLED = oldFlag;
      const response = await fetch(server.url + '/api/v1/session');
      assert.equal(response.status, enabled === 'true' ? 200 : 503);
      for (const path of retiredRoutes.POST) {
        const response = await fetch(`${server.url}/api/${path}`, { method: 'POST', headers: { origin: server.url } });
        assert.equal(response.status, 409); assert.match(await response.text(), /entered text/);
      }
    }
    assert.deepEqual(documents, before);
  } finally {
    if (api === undefined) delete process.env.V1_API_ENABLED; else process.env.V1_API_ENABLED = api;
    if (client === undefined) delete process.env.V1_CLIENT_ENABLED; else process.env.V1_CLIENT_ENABLED = client;
  }
});

test('canonical shell uses local assets, safe routing and no fragment runtime', async () => {
  const root = new URL('../../html/', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /type="module" src="\/inbox.js\?v=23"/);
  assert.equal(new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])).size, [...html.matchAll(/\bid="([^"]+)"/g)].length);
  assert.match(await readFile(new URL('inbox.html', root), 'utf8'), /url=\//);
  for (const path of await readdir(root)) {
    if (!/\.(html|js)$/.test(path)) continue;
    assert.doesNotMatch(await readFile(new URL(path, root), 'utf8'), /htmx|\bhx-[a-z]|cdn\.jsdelivr|HX-Redirect/);
  }
  const config = JSON.parse(await readFile(new URL('staticwebapp.config.json', root), 'utf8'));
  assert.ok(config.navigationFallback.exclude.includes('/api/*'));
  assert.ok(config.navigationFallback.exclude.includes('/.auth/*'));
  assert.doesNotMatch(config.globalHeaders['content-security-policy'], /unsafe-inline|jsdelivr/);
  assert.deepEqual([...routes.keys()].filter(key => key.startsWith('POST /api/v1/')), ['POST /api/v1/operations']);
});
