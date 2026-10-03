import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyDeployment } from '../scripts/verify-pwa-deployment.mjs';

const html = new URL('../../html/', import.meta.url);
const config = JSON.parse(await readFile(new URL('staticwebapp.config.json', html), 'utf8'));
async function fixture(url, options) {
  assert.equal(url.origin, 'https://pwa.example');
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  assert.ok(!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/.auth/'));
  if (url.pathname.startsWith('/icons/pwa-verification-missing-')) return new Response('Not found', { status: 404 });
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/manifest+json' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
  const bytes = await readFile(new URL(file, html));
  return new Response(file.endsWith('.png') ? bytes : bytes.toString().replace(/\r\n/g, '\n'), { headers: {
    'content-type': `${type}; charset=utf-8`,
    'content-security-policy': config.globalHeaders['content-security-policy'],
  } });
}

test('deployed PWA checks verify anonymous public assets and accept Git line-ending differences', async () => {
  const report = await verifyDeployment('https://pwa.example', { fetchImpl: fixture });
  assert.equal(report.status, 'PASS');
  assert.equal(report.checks.length, 8);
  assert.ok(report.checks.every(check => check.status === 'PASS'));
  assert.equal(report.checks.filter(check => check.actualSha256 === check.expectedSha256 && check.actualSha256).length, 7);
});

for (const [name, change, failure] of [
  ['HTML fallback for a missing icon', () => new Response('<html>shell</html>'), 'Expected HTTP 404.'],
  ['redirect to authentication', () => new Response(null, { status: 302, headers: { location: '/.auth/login/github' } }), 'Expected HTTP 200.'],
  ['wrong MIME type', response => { response.headers.set('content-type', 'text/html'); return response; }, 'Unexpected Content-Type.'],
  ['missing CSP', response => { response.headers.delete('content-security-policy'); return response; }, 'Content-Security-Policy differs'],
  ['blocking CSP', response => { response.headers.set('content-security-policy', "default-src 'none'"); return response; }, 'Content-Security-Policy differs'],
  ['stale or HTML asset body', response => new Response('stale body', { headers: response.headers }), 'Body differs'],
  ['timeout', () => { throw new DOMException('private details', 'TimeoutError'); }, 'Request timed out.'],
  ['network failure', () => { throw new Error('private details'); }, 'Request or asset read failed.'],
]) {
  test(`deployed PWA checks fail for ${name} and continue collecting evidence`, async () => {
    const report = await verifyDeployment('https://pwa.example', { fetchImpl: async (url, options) => {
      const response = await fixture(url, options);
      const selected = name.startsWith('HTML fallback') ? url.pathname.startsWith('/icons/pwa-verification-missing-') : url.pathname === '/manifest.json';
      return selected ? change(response) : response;
    } });
    assert.equal(report.status, 'FAIL');
    assert.equal(report.checks.length, 8);
    const failed = report.checks.filter(check => check.status === 'FAIL');
    assert.equal(failed.length, 1);
    assert.ok(failed[0].failures.some(message => message.startsWith(failure)));
    assert.ok(!JSON.stringify(report).includes('private details'));
  });
}

test('deployed PWA checks reject non-origin and non-HTTPS targets before fetching', async () => {
  for (const origin of ['http://pwa.example', 'https://user:password@pwa.example', 'https://pwa.example/path', 'https://pwa.example/?secret=1', 'https://pwa.example/#fragment']) {
    await assert.rejects(verifyDeployment(origin, { fetchImpl: () => assert.fail('must not fetch') }), /Supply an HTTPS origin/);
  }
});
