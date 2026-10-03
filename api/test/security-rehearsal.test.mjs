import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documents, startServer, routes } from './harness.mjs';
import { configuration, request, rehearse, main } from '../scripts/rehearse-security.mjs';

const env = { SECURITY_ORIGIN: 'https://staging.example', SECURITY_COOKIE_A: 'session=private-A',
  SECURITY_COOKIE_B: 'session=private-B', SECURITY_DEPLOYED_COMMIT: 'a'.repeat(40) };
const args = ['--disposable-environment', 'report.jsonl'];

test('security runner requires explicit disposable HTTPS target, two sessions and deployed commit', () => {
  assert.equal(configuration(args, env).origin, env.SECURITY_ORIGIN);
  for (const change of [
    { SECURITY_ORIGIN: 'http://staging.example' }, { SECURITY_ORIGIN: 'https://staging.example/path' },
    { SECURITY_ORIGIN: 'https://user:password@staging.example' }, { SECURITY_ORIGIN: 'https://staging.example/' },
    { SECURITY_COOKIE_A: '' }, { SECURITY_COOKIE_B: env.SECURITY_COOKIE_A }, { SECURITY_COOKIE_A: 'a\r\nb' },
    { SECURITY_DEPLOYED_COMMIT: '' }, { SECURITY_BACKEND_ORIGIN: 'http://backend.example' },
    { SECURITY_BACKEND_ORIGIN: env.SECURITY_ORIGIN }
  ]) assert.throws(() => configuration(args, { ...env, ...change }));
  assert.throws(() => configuration(['report.jsonl'], env));
});

test('transport never follows redirects, limits bodies and retains only numeric status and header checks', async () => {
  let options;
  const reply = await request('https://staging.example', 'v1/session', { cookie: 'private-cookie' }, async (url, init) => {
    assert.equal(url.href, 'https://staging.example/api/v1/session');
    options = init;
    return new Response('private response text', { status: 302, headers: { location: 'https://foreign.example', 'set-cookie': 'private-cookie', 'cache-control': 'no-store' } });
  });
  assert.equal(options.redirect, 'manual');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(reply.status, 302);
  assert.equal(JSON.stringify(reply).includes('private-cookie'), false);
  await assert.rejects(request('https://staging.example', 'v1/session', {}, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))));
  const cached = await request('https://staging.example', 'v1/session', {}, async () => new Response('{}', { headers: { 'cache-control': 'public, no-store' } }));
  assert.equal(cached.protection.noStore, false);
});

async function fixture(t, intercept = reply => reply) {
  documents.length = 0;
  const server = await startServer();
  t.after(server.close);
  const seen = [];
  // Only this test simulates the SWA edge. The shipped runner sends real cookies
  // to HTTPS and never manufactures a principal for authenticated requests.
  const send = async (origin, path, options) => {
    seen.push({ origin, path, options });
    const cookie = options.cookie;
    const user = cookie === env.SECURITY_COOKIE_A ? 'secret-account-A' : cookie === env.SECURITY_COOKIE_B ? 'secret-account-B' : null;
    const headers = { ...options.headers };
    delete headers['x-ms-client-principal'];
    if (user) headers['x-ms-client-principal'] = Buffer.from(JSON.stringify({ userId: user, userRoles: ['authenticated'] })).toString('base64');
    if (headers.origin === env.SECURITY_ORIGIN) headers.origin = server.url;
    if (headers.referer === env.SECURITY_ORIGIN + '/') headers.referer = server.url + '/';
    return intercept(await request(server.url, path, { ...options, headers }), path, options);
  };
  const report = {};
  const run = () => rehearse({ origin: env.SECURITY_ORIGIN, cookies: [env.SECURITY_COOKIE_A, env.SECURITY_COOKIE_B], report, send });
  return { report, seen, run, send };
}

test('complete deployed security scenarios exercise real handlers, route coverage and cleanup without leaking identities', async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.report.status, 'PASS', JSON.stringify(f.report.failure));
  assert.equal(f.report.cleanup, 'tombstoned');
  assert.ok(f.report.checks.every(check => check.status === 'PASS'));
  const output = JSON.stringify(f.report);
  for (const secret of ['secret-account-A', 'secret-account-B', env.SECURITY_COOKIE_A, env.SECURITY_COOKIE_B, 'Security rehearsal item']) assert.equal(output.includes(secret), false);
  const mutationRoutes = [...routes.keys()].filter(route => route.startsWith('POST ')).map(route => route.slice('POST /api/'.length)).sort();
  const probedRoutes = [...new Set(f.report.requests.filter(row => row.phase.startsWith('every mutation')).map(row => row.route))].filter(route => mutationRoutes.includes(route)).sort();
  assert.deepEqual(probedRoutes, mutationRoutes, 'add deployed origin probes for new mutation routes');
  const readRoutes = [...routes.keys()].filter(route => /^GET \/api\/(v1|shared)\//.test(route)).map(route => route.slice('GET /api/'.length)).sort();
  assert.deepEqual([...new Set(f.report.requests.filter(row => readRoutes.includes(row.route)).map(row => row.route))].sort(), readRoutes,
    'add deployed isolation probes for new v1 read routes');
  assert.equal(documents.filter(doc => doc.kind === 'record').length, 6);
  assert.ok(documents.filter(doc => doc.kind === 'record').every(doc => doc.record.deleted));
  assert.ok(documents.some(doc => doc.kind === 'receipt'), 'cleanup must retain protocol history');
});

test('same account sessions and unsafe edge caching fail before any writes', async t => {
  for (const failure of ['same-account', 'cache']) {
    const f = await fixture(t, (reply, path, options) => {
      if (failure === 'cache' && !options.cookie) reply.protection.noStore = false;
      if (failure === 'same-account' && reply.status === 200 && path === 'v1/session') reply.data.accountId = 'same-account';
      return reply;
    });
    await f.run();
    assert.equal(f.report.status, 'FAIL');
    assert.equal(f.report.fixtures.length, 0);
    assert.equal(documents.length, 0);
  }
});

test('lost create acknowledgement is sanitized and generated records are still cleaned up', async t => {
  let lost = false;
  const f = await fixture(t, (reply, path, options) => {
    if (!lost && path === 'v1/operations' && options.body?.mutations[0].action === 'create') {
      lost = true;
      throw new Error('private-cookie private response text secret-account-A');
    }
    return reply;
  });
  await f.run();
  assert.equal(f.report.status, 'FAIL');
  assert.equal(f.report.cleanup, 'tombstoned');
  assert.equal(f.report.failure.code, 'request_failed');
  assert.ok(documents.filter(doc => doc.kind === 'record').every(doc => doc.record.deleted));
  assert.doesNotMatch(JSON.stringify(f.report), /private-cookie|private response text|secret-account-A/);
});

test('a successful anonymous impersonation or accepted invalid origin cannot pass the rehearsal', async t => {
  for (const failure of ['impersonation', 'origin']) {
    const f = await fixture(t, (reply, path, options) => {
      if (failure === 'impersonation' && !options.cookie && options.headers?.['x-ms-client-principal']) reply.status = 200;
      if (failure === 'origin' && path === 'v1/operations' && reply.status === 403) reply.status = 200;
      return reply;
    });
    await f.run();
    assert.equal(f.report.status, 'FAIL');
    assert.equal(f.report.failure.code, 'assertion_failed');
    assert.ok(documents.filter(doc => doc.kind === 'record').every(doc => doc.record.deleted));
  }
});

test('a detected foreign read and a cleanup outage fail the run and preserve fixture recovery IDs', async t => {
  let cleanup = false;
  const f = await fixture(t, (reply, path, options) => {
    if (path.startsWith('v1/records?') && reply.status === 409) { reply.status = 200; cleanup = true; }
    if (cleanup && path === 'v1/operations' && options.body?.mutations[0].action === 'delete') throw new Error('private error');
    return reply;
  });
  await f.run();
  assert.equal(f.report.status, 'FAIL');
  assert.equal(f.report.cleanup, 'failed');
  assert.ok(f.report.fixtures.length >= 6);
  assert.ok(f.report.checks.some(check => check.name.startsWith('cleanup') && check.status === 'FAIL'));
});

test('optional direct ingress checks never receive either session cookie', async t => {
  const f = await fixture(t);
  await rehearse({ origin: env.SECURITY_ORIGIN, backendOrigin: 'https://backend.example',
    cookies: [env.SECURITY_COOKIE_A, env.SECURITY_COOKIE_B], report: f.report, send: f.send });
  assert.equal(f.report.status, 'PASS');
  const direct = f.seen.filter(row => row.origin === 'https://backend.example');
  assert.equal(direct.length, 2);
  assert.ok(direct.every(row => row.options.cookie === undefined));
  assert.match(f.report.topology, /UNVERIFIED/);
});

test('CLI refuses missing opt-in and never overwrites an existing report', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'security-rehearsal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'evidence.jsonl');
  await writeFile(path, 'prior evidence');
  assert.equal(await main([], env), 1);
  assert.equal(await main(['--disposable-environment', path], env), 1);
  assert.equal(await readFile(path, 'utf8'), 'prior evidence');
});
