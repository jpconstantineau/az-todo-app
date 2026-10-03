import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { documents, startServer } from './harness.mjs';
import { document } from '../api/v1/contract.mjs';
import { accountExport, validateAccountExport, validateDeviceExport, readableExport } from '../../html/inbox-export.js';
import capture from './fixtures/v1-operations.json' with { type: 'json' };

async function fixture(t) {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  async function request(path, body, user = 'alice') {
    const response = await fetch(`${server.url}/api/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { origin: server.url, 'content-type': 'application/json', ...(user ? {
        'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: user, userRoles: ['authenticated'] })).toString('base64')
      } : {}) }, body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return { status: response.status, body: await response.json() };
  }
  const get = async path => { const result = await request(path); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  let operation = 0;
  const edit = (id, version, fields, action = 'update') => request('operations', {
    apiVersion: 1, accountId: 'alice', operationId: `${id}-${++operation}`,
    mutations: [{ id, type: 'item', expectedVersion: version, action, ...(fields ? { fields } : {}) }]
  });
  return { request, get, edit };
}

test('account export pins history across pages and concurrent writes, keeps tombstones, and round-trips without writes', async t => {
  const f = await fixture(t);
  await f.request('operations', capture);
  assert.equal((await f.edit('milk', 1, { title: 'Milk at cutoff' })).status, 200);
  assert.equal((await f.edit('bread', 1, undefined, 'delete')).status, 200);
  assert.equal((await f.edit('milk', 1, { title: 'Stale proposal' }, 'update')).status, 409);
  documents.push(document('alice', 'legacy-settings', { kind: 'legacy-settings', settings: { defaults: { contexts: ['Home'] } } }));
  let calls = 0;
  const value = await accountExport('alice', async path => {
    const page = await f.get(path.replace('limit=50', 'limit=1'));
    if (++calls === 1) assert.equal((await f.edit('milk', 2, { title: 'Newer than cutoff' })).status, 200);
    return page;
  });
  assert.equal(calls, 4);
  assert.equal(value.state.after, 4);
  assert.equal(value.state.records['item:milk'].title, 'Milk at cutoff');
  assert.equal(value.state.records['item:milk'].originalText, '  milk\n');
  assert.equal(value.state.records['item:bread'].deleted, true);
  assert.deepEqual(value.state.legacyDefaults, { contexts: ['Home'] });
  assert.deepEqual(validateAccountExport(value), { records: 4, pendingOperations: 0, warnings: [] });
  assert.throws(() => validateDeviceExport(value), /unsupported format/);
  assert.match(readableExport(value), /Server history cutoff: 4/);
  assert.doesNotMatch(readableExport(value), /Newer than cutoff|Stale proposal|PENDING SAVES/);
  const before = structuredClone(documents);
  const latest = await accountExport('alice', f.get);
  assert.equal(latest.state.records['item:milk'].title, 'Newer than cutoff');
  assert.deepEqual(documents, before);
  const directory = await mkdtemp(join(tmpdir(), 'todo-account-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.json'), output = join(directory, 'output.json');
  await writeFile(input, JSON.stringify(value));
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/validate-device-export.mjs', import.meta.url)), input, output], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), value);
  assert.equal(run().status, 1, 'never overwrite a previous recovery file');
});

test('export authenticates every page, validates bounds, and rejects unavailable or missing history', async t => {
  const f = await fixture(t);
  await f.request('operations', capture);
  assert.equal((await f.request('export?accountId=alice', undefined, null)).status, 401);
  assert.equal((await f.request('export?accountId=alice', undefined, 'bob')).status, 409);
  const bob = await f.request('export?accountId=bob', undefined, 'bob');
  assert.equal(bob.status, 200); assert.deepEqual(bob.body.entries, []);
  for (const params of ['after=1', 'through=-1', 'through=1.5', 'through=9007199254740992', 'limit=0', 'limit=51', 'after=wat']) {
    assert.equal((await f.request(`export?accountId=alice&${params}`)).status, 400, params);
  }
  assert.equal((await f.request('export?accountId=alice&through=2')).body.error, 'snapshot_unavailable');
  assert.equal((await f.request('export?accountId=alice&after=1&through=0')).body.error, 'cursor_ahead');
  const empty = await accountExport('alice', path => f.get(path + '&through=0'));
  assert.deepEqual(empty.state.records, {});
  documents.splice(documents.findIndex(d => d.id === 'change:1'), 1);
  assert.equal((await f.request('export?accountId=alice')).body.error, 'history_gap');
});

test('collector rejects mixed accounts, changing cutoffs, stalled/corrupt pages, cancellation and overlarge histories', async () => {
  const page = { apiVersion: 1, accountId: 'alice', highWater: 1, nextAfter: 1, hasMore: false,
    entries: [{ apiVersion: 1, accountId: 'alice', sequence: 1, status: 'committed', records: [
      { type: 'item', id: 'a', accountId: 'alice', version: 1, deleted: false, originalText: 'Exact original' }
    ] }] };
  for (const change of [
    p => { p.accountId = 'bob'; }, p => { p.entries[0].accountId = 'bob'; },
    p => { p.entries[0].records[0].accountId = 'bob'; }, p => { p.entries[0].sequence = 2; },
    p => { p.highWater = -1; }, p => { p.nextAfter = 0; }, p => { p.hasMore = true; },
    p => { p.entries[0].status = 'conflict'; }, p => { p.entries[0].records[0].version = 0; },
    p => { p.entries = []; p.nextAfter = 0; p.hasMore = true; }
  ]) {
    const bad = structuredClone(page); change(bad);
    await assert.rejects(accountExport('alice', async () => bad), /Invalid/);
  }
  let calls = 0;
  await assert.rejects(accountExport('alice', async () => ++calls === 1 ? { ...page, highWater: 2, hasMore: true } : page), /Invalid/);
  const controller = new AbortController();
  await assert.rejects(accountExport('alice', async () => { controller.abort(); return page; }, { signal: controller.signal }), /abort/i);
  const large = { ...page, padding: 'x'.repeat(1024 * 1024) };
  calls = 0;
  await assert.rejects(accountExport('alice', async () => {
    const sequence = ++calls;
    return { ...large, highWater: 100, nextAfter: sequence, hasMore: true,
      entries: [{ ...page.entries[0], sequence, records: [] }] };
  }), /50 MiB/);
  assert.ok(calls < 100);
});
