import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documents, startServer } from './harness.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('API build, lockfile, managed runtime and CI select the same Node major', async () => {
  const pkg = JSON.parse(await read('../package.json'));
  const lock = JSON.parse(await read('../package-lock.json'));
  const config = JSON.parse(await read('../../html/staticwebapp.config.json'));
  const workflow = await read('../../.github/workflows/test.yml');
  const major = pkg.engines.node.match(/^(\d+)\.x$/)?.[1];
  assert.ok(major, 'pin the API build to a supported Node major');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.equal(config.platform.apiRuntime, 'node:' + major);
  assert.ok(workflow.includes("node-version: '" + major + "'"));
});

test('health reports the actual runtime only to authenticated callers without writing', async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  const anonymous = await fetch(server.url + '/api/health');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('x-node-version'), null);
  const principal = Buffer.from(JSON.stringify({ userId: 'runtime-check', userRoles: ['authenticated'] })).toString('base64');
  const response = await fetch(server.url + '/api/health', { headers: { 'x-ms-client-principal': principal } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
  assert.equal(response.headers.get('x-node-version'), process.version);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(documents.length, 0);
});
