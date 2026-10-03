import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const retired = ['lists/create', 'items/create', 'items/toggleComplete', 'lists/updateDefaults',
  'lists/resetDefaults', 'settings/update', 'settings/reset', 'settings/ensure'];
const principal = userId => Buffer.from(JSON.stringify({ userId, userRoles: ['authenticated'] })).toString('base64');
const failureCode = error => error?.code === 'ERR_ASSERTION' ? 'assertion_failed' : 'request_failed';

export function configuration(args, env) {
  if (args.length !== 2 || args[0] !== '--disposable-environment') throw new Error('Invalid arguments');
  const origin = value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) throw new Error('Exact HTTPS origin required');
    return value;
  };
  const cookies = [env.SECURITY_COOKIE_A, env.SECURITY_COOKIE_B];
  if (cookies.some(value => typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) || cookies[0] === cookies[1]) {
    throw new Error('Two independent sessions required');
  }
  if (!/^[a-f0-9]{40}$/i.test(env.SECURITY_DEPLOYED_COMMIT ?? '')) throw new Error('Deployed commit required');
  const swaOrigin = origin(env.SECURITY_ORIGIN);
  const backendOrigin = env.SECURITY_BACKEND_ORIGIN ? origin(env.SECURITY_BACKEND_ORIGIN) : null;
  if (backendOrigin === swaOrigin) throw new Error('Direct backend must differ from SWA');
  return { origin: swaOrigin, cookies, deployedCommit: env.SECURITY_DEPLOYED_COMMIT, backendOrigin, outputPath: args[1] };
}

// Never follow redirects with session credentials. Consume bounded response bodies
// under the same timeout; neither bodies nor exception details enter the report.
export async function request(origin, path, { cookie, headers = {}, body } = {}, fetcher = fetch) {
  const response = await fetcher(new URL('/api/' + path, origin), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const reader = response.body?.getReader(), chunks = [];
  let size = 0;
  if (reader) {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(part.value);
    }
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Edge denials may be HTML. */ }
  const cache = response.headers.get('cache-control') ?? '';
  return { status: response.status, data, protection: {
    noStore: /(?:^|,)\s*no-store\s*(?:,|$)/i.test(cache) && !/(?:^|,)\s*(?:public|s-maxage\s*=)/i.test(cache),
    private: /(?:^|,)\s*private\s*(?:,|$)/i.test(cache),
    nosniff: response.headers.get('x-content-type-options') === 'nosniff',
    noReferrer: response.headers.get('referrer-policy') === 'no-referrer',
    denyFrame: response.headers.get('x-frame-options')?.toUpperCase() === 'DENY',
    csp: ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].every(
      directive => (response.headers.get('content-security-policy') ?? '').split(';').some(value => value.trim() === directive))
  } };
}

export async function rehearse({ origin, cookies, backendOrigin = null, report, checkpoint = async () => {}, send = request }) {
  Object.assign(report, { status: 'RUNNING', checks: [], requests: [], fixtures: [], cleanup: 'not_needed',
    topology: 'UNVERIFIED: inspect Azure resource topology independently' });
  const accounts = [];
  let phase;
  const check = async (name, action) => {
    phase = name;
    const result = { name, status: 'RUNNING' };
    report.checks.push(result);
    await checkpoint();
    try { await action(); result.status = 'PASS'; }
    catch (error) { result.status = 'FAIL'; result.code = failureCode(error); throw error; }
    finally { await checkpoint(); }
  };
  const call = async (path, { account, headers, body, edge = false, target = origin } = {}) => {
    const reply = await send(target, path, { cookie: account?.cookie, headers, body });
    report.requests.push({ phase, route: path.split('?')[0], account: account?.label ?? 'anonymous',
      target: target === origin ? 'SWA' : 'backend', status: reply.status, protection: reply.protection });
    await checkpoint();
    assert.equal(reply.protection.noStore, true);
    if (!edge) assert.ok(Object.values(reply.protection).every(Boolean));
    return reply;
  };
  const read = async (account, type, id) => call('v1/records?' + new URLSearchParams({ accountId: account.id, type, id }), { account });
  const operation = (account, mutations) => ({ apiVersion: 1, accountId: account.id, operationId: randomUUID(), mutations });
  const post = (account, body, headers = { origin }) => call('v1/operations', { account, body, headers });
  const create = (type, id, fields) => ({ type, id, action: 'create', expectedVersion: 0, fields });
  const track = async (account, type = 'item') => {
    const fixture = { account: account.label, type, id: 'security-' + randomUUID() };
    report.fixtures.push(fixture);
    report.cleanup = 'pending';
    await checkpoint(); // Persist exact generated IDs before any potentially committed write.
    return fixture.id;
  };
  const expect = (reply, status, error) => {
    assert.equal(reply.status, status);
    if (error) assert.equal(reply.data?.error, error);
    return reply.data;
  };
  const committed = reply => {
    const value = expect(reply, 200);
    assert.equal(value?.status, 'committed');
    return value;
  };
  try {
    await check('anonymous and forged principals are denied at SWA', async () => {
      for (const headers of [{}, { 'x-ms-client-principal': principal('security-forged'), 'HX-Request': 'true' }]) {
        const reply = await call('v1/session', { headers, edge: true });
        assert.ok([401, 403].includes(reply.status));
      }
    });
    if (backendOrigin) await check('direct backend denies anonymous and forged principals without cookies', async () => {
      for (const headers of [{}, { 'x-ms-client-principal': principal('security-forged') }]) {
        const reply = await call('v1/session', { target: backendOrigin, headers, edge: true });
        assert.ok([401, 403].includes(reply.status));
      }
    });
    await check('two authenticated sessions and principal override isolation', async () => {
      for (const [index, cookie] of cookies.entries()) {
        const account = { cookie, label: index === 0 ? 'A' : 'B' };
        const session = expect(await call('v1/session', { account }), 200);
        assert.equal(session?.apiVersion, 1);
        assert.ok(typeof session.accountId === 'string' && session.accountId);
        account.id = session.accountId;
        accounts.push(account);
      }
      assert.notEqual(accounts[0].id, accounts[1].id);
      for (const account of accounts) {
        const other = accounts.find(value => value !== account);
        const session = expect(await call('v1/session', { account, headers: { 'x-ms-client-principal': principal(other.id) } }), 200);
        assert.equal(session.accountId, account.id);
      }
    });
    await check('valid origin, matching referer and referer-only writes commit for both accounts', async () => {
      for (const account of accounts) {
        account.list = await track(account, 'list');
        account.project = await track(account, 'project');
        account.item = await track(account);
        const fixtures = [
          [create('list', account.list, { title: 'Security rehearsal list' }), { origin }],
          [create('project', account.project, { title: 'Security rehearsal project', outcome: 'Verify isolation' }), { origin, referer: origin + '/', 'sec-fetch-site': 'same-origin' }],
          [create('item', account.item, { title: 'Security rehearsal item', listId: account.list, projectId: account.project }), { referer: origin + '/' }]
        ];
        for (const [mutation, headers] of fixtures) {
          const body = operation(account, [mutation]);
          const receipt = committed(await post(account, body, headers));
          assert.equal(receipt.accountId, account.id);
          assert.equal(receipt.records[0].id, mutation.id);
          assert.equal(receipt.records[0].version, 1);
          account.receipt = body.operationId;
        }
      }
    });
    await check('every mutation route rejects untrusted origins without changing account history', async () => {
      const account = accounts[0];
      const history = () => call('v1/changes?' + new URLSearchParams({ accountId: account.id, limit: '1' }), { account });
      const before = expect(await history(), 200).highWater;
      const id = await track(account);
      const mutation = create('item', id, { title: 'Rejected origin probe' });
      const wrongPort = new URL(origin);
      wrongPort.port = wrongPort.port === '444' ? '445' : '444';
      const invalid = [{}, { origin: '' }, { origin: 'null' }, { origin: 'not-a-url' }, { origin: 'https://foreign.invalid' },
        { origin: origin + '.foreign.invalid' }, { origin: origin + '/' }, { origin: origin + '/path' },
        { origin: origin.replace('https:', 'http:') }, { origin: wrongPort.origin },
        { origin: 'https://user:password@foreign.invalid' },
        { origin, referer: 'https://foreign.invalid/' }, { origin, referer: 'malformed' },
        { origin: 'https://foreign.invalid', referer: origin + '/' },
        { origin, 'sec-fetch-site': 'cross-site' }, { origin, 'sec-fetch-site': 'same-site' },
        { 'HX-Request': 'true', 'x-forwarded-host': new URL(origin).host }];
      for (const route of ['v1/operations', ...retired]) {
        for (const headers of invalid) {
          const body = operation(account, [mutation]);
          const reply = await call(route, { account, headers, body: route === 'v1/operations' ? body : {} });
          expect(reply, 403, route === 'v1/operations' ? 'untrusted_origin' : undefined);
          if (route === 'v1/operations') expect(await call('v1/receipts?' + new URLSearchParams({ accountId: account.id, operationId: body.operationId }), { account }), 404, 'receipt_not_found');
        }
        if (route !== 'v1/operations') expect(await call(route, { account, headers: { origin }, body: {} }), 409);
      }
      expect(await read(account, 'item', id), 404, 'record_not_found');
      assert.equal(expect(await history(), 200).highWater, before);
    });
    await check('foreign account reads, exports, receipts and writes fail in both directions', async () => {
      for (const account of accounts) {
        const other = accounts.find(value => value !== account);
        for (const [route, query] of [
          ['records', { type: 'item', id: other.item }], ['receipts', { operationId: other.receipt }], ['changes', {}], ['export', {}]
        ]) {
          expect(await call('v1/' + route + '?' + new URLSearchParams({ accountId: other.id, ...query }), { account }), 409, 'account_mismatch');
        }
        for (const type of ['list', 'project', 'item']) expect(await read(account, type, other[type]), 404, 'record_not_found');
        expect(await call('v1/receipts?' + new URLSearchParams({ accountId: account.id, operationId: other.receipt }), { account }), 404, 'receipt_not_found');
        for (const action of ['update', 'delete']) {
          const mutation = { type: 'item', id: other.item, action, expectedVersion: 1, ...(action === 'update' ? { fields: { title: 'Foreign edit' } } : {}) };
          expect(await post(account, operation(other, [mutation])), 409, 'account_mismatch');
          const conflict = expect(await post(account, operation(account, [mutation])), 409);
          assert.equal(conflict.status, 'conflict');
          assert.equal(conflict.conflicts[0].current, null);
          assert.deepEqual(conflict.records, []);
        }
        for (const field of ['listId', 'projectId']) {
          const type = field === 'listId' ? 'list' : 'project';
          const mutation = { type: 'item', id: account.item, action: 'update', expectedVersion: 1, fields: { [field]: other[type] } };
          expect(await post(account, operation(account, [mutation])), 404, type + '_not_found');
        }
        const forged = operation(account, [{ type: 'item', id: account.item, action: 'update', expectedVersion: 1, fields: { title: 'Forged owner', UserID: other.id } }]);
        expect(await post(account, forged), 400, 'invalid_request');
        for (const fields of [{ title: 'x'.repeat(201) }, { status: 'security-invalid-' + randomUUID() }]) {
          expect(await post(account, operation(account, [{ type: 'item', id: account.item, action: 'update', expectedVersion: 1, fields }])), 400, 'invalid_request');
        }
        for (const target of [account, other]) {
          const saved = expect(await read(target, 'item', target.item), 200).record;
          assert.equal(saved.accountId, target.id);
          assert.equal(saved.version, 1);
          assert.equal(saved.deleted, false);
        }
      }
    });
    await check('paginated changes and exports return only their authenticated account', async () => {
      for (const account of accounts) for (const route of ['changes', 'export']) {
        let after = 0, through, pages = 0;
        const ids = new Set();
        while (true) {
          assert.ok(++pages <= 100, 'Use disposable accounts with bounded history');
          const query = { accountId: account.id, after: String(after), limit: '1', ...(route === 'export' && through !== undefined ? { through: String(through) } : {}) };
          const page = expect(await call('v1/' + route + '?' + new URLSearchParams(query), { account }), 200);
          assert.equal(page.accountId, account.id);
          through ??= page.highWater;
          for (const entry of page.entries) {
            assert.equal(entry.accountId, account.id);
            for (const record of entry.records) { assert.equal(record.accountId, account.id); ids.add(record.id); }
            for (const conflict of entry.conflicts ?? []) if (conflict.current) assert.equal(conflict.current.accountId, account.id);
          }
          if (!page.hasMore) break;
          assert.ok(page.nextAfter > after);
          after = page.nextAfter;
        }
        assert.ok(pages > 1);
        for (const type of ['list', 'project', 'item']) {
          assert.ok(ids.has(account[type]));
          assert.equal(ids.has(accounts.find(value => value !== account)[type]), false);
        }
      }
    });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failure = { phase, code: failureCode(error) };
  } finally {
    // Re-read only generated IDs, including uncertain creates. Delete items first,
    // then empty parents. Tombstones/receipts/history deliberately remain.
    if (report.fixtures.length) {
      report.cleanup = 'tombstoned';
      for (const fixture of [...report.fixtures].sort((a, b) => Number(b.type === 'item') - Number(a.type === 'item'))) {
        try {
          await check('cleanup ' + fixture.type + ' ' + fixture.id, async () => {
            const account = accounts.find(value => value.label === fixture.account);
            const reply = await read(account, fixture.type, fixture.id);
            if (reply.status === 404) { expect(reply, 404, 'record_not_found'); return; }
            const record = expect(reply, 200).record;
            assert.equal(record.accountId, account.id);
            assert.equal(record.id, fixture.id);
            assert.equal(record.type, fixture.type);
            if (!record.deleted) committed(await post(account, operation(account, [{ type: fixture.type, id: fixture.id, action: 'delete', expectedVersion: record.version }])));
            assert.equal(expect(await read(account, fixture.type, fixture.id), 200).record.deleted, true);
          });
        } catch { report.cleanup = 'failed'; report.status = 'FAIL'; }
      }
    }
    report.finishedUtc = new Date().toISOString();
    await checkpoint();
  }
  return report;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let config, output;
  try { config = configuration(args, env); }
  catch {
    console.error('Usage: node scripts/rehearse-security.mjs --disposable-environment <new-report.jsonl>\nSet SECURITY_ORIGIN (exact HTTPS origin), SECURITY_DEPLOYED_COMMIT (40-character SHA), SECURITY_COOKIE_A and SECURITY_COOKIE_B (distinct disposable SWA sessions). Optional SECURITY_BACKEND_ORIGIN tests direct ingress without cookies. This writes synthetic records and retains tombstones/history.');
    return 1;
  }
  try { output = await open(config.outputPath, 'wx', 0o600); }
  catch { console.error('Cannot create report; use a new writable path. Existing evidence is never overwritten.'); return 1; }
  const report = { formatVersion: 1, startedUtc: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, origin: config.origin,
    declaredDeployedCommit: config.deployedCommit, backendOrigin: config.backendOrigin,
    scope: 'HTTP security probes only. Deployed commit is operator-declared. Azure topology, browser behavior and other release gates require separate evidence.' };
  const checkpoint = async () => { await output.write(JSON.stringify(report) + '\n'); await output.sync(); };
  try {
    await rehearse({ ...config, report, checkpoint });
    console.log(`Security rehearsal ${report.status}; cleanup: ${report.cleanup}. Inspect the report and the remaining manual gates.`);
    return report.status === 'PASS' ? 0 : 1;
  } catch {
    console.error('Security rehearsal interrupted. Inspect the last complete report line for generated fixture IDs and cleanup status.');
    return 1;
  } finally { await output.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
