import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const html = new URL('../../html/', import.meta.url);
// Git may check out text with CRLF on Windows while Azure serves LF blobs.
const sha256 = (bytes, file) => createHash('sha256')
  .update(file.endsWith('.png') ? bytes : bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
const assets = [
  ['/', 'index.html', ['text/html']],
  ['/manifest.json', 'manifest.json', ['application/json', 'application/manifest+json']],
  ['/icons/icon-192.png', 'icons/icon-192.png', ['image/png']],
  ['/icons/icon-512.png', 'icons/icon-512.png', ['image/png']],
  ['/icons/apple-touch-icon.png', 'icons/apple-touch-icon.png', ['image/png']],
  ['/inbox-sw.js', 'inbox-sw.js', ['text/javascript', 'application/javascript']],
];

// Verify this repository's public deployment contract, without cookies, API
// requests, browser storage, or writes to the target environment.
export async function verifyDeployment(origin, { fetchImpl = fetch } = {}) {
  const target = new URL(origin);
  if (target.protocol !== 'https:' || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) {
    throw new Error('Supply an HTTPS origin without credentials, path, query or fragment.');
  }
  const config = JSON.parse(await readFile(new URL('staticwebapp.config.json', html), 'utf8'));
  const report = { origin: target.origin, checkedAt: new Date().toISOString(), status: 'PASS', checks: [] };
  const checks = [...assets, [`/icons/pwa-verification-missing-${randomUUID()}.png`, null, []]];
  for (const [path, file, types] of checks) {
    const result = { path, status: 'FAIL', failures: [] };
    report.checks.push(result);
    try {
      const response = await fetchImpl(new URL(path, target), {
        method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      result.httpStatus = response.status;
      result.contentType = response.headers.get('content-type');
      const expectedStatus = file ? 200 : 404;
      if (response.status !== expectedStatus) result.failures.push(`Expected HTTP ${expectedStatus}.`);
      if (file) {
        const type = result.contentType?.split(';')[0].trim().toLowerCase();
        if (!types.includes(type)) result.failures.push('Unexpected Content-Type.');
        result.contentSecurityPolicy = response.headers.get('content-security-policy');
        if (result.contentSecurityPolicy !== config.globalHeaders['content-security-policy']) {
          result.failures.push('Content-Security-Policy differs from the reviewed repository policy.');
        }
        result.expectedSha256 = sha256(await readFile(new URL(file, html)), file);
        result.actualSha256 = sha256(Buffer.from(await response.arrayBuffer()), file);
        if (result.actualSha256 !== result.expectedSha256) result.failures.push('Body differs from the local checkout asset.');
      } else {
        // A real 404 may have an HTML error body; a 200 navigation fallback fails.
        await response.body?.cancel();
      }
    } catch (error) {
      // Do not put response bodies, redirect destinations or raw errors in evidence.
      result.failures.push(error?.name === 'TimeoutError' ? 'Request timed out.' : 'Request or asset read failed.');
    }
    if (!result.failures.length) result.status = 'PASS';
    else report.status = 'FAIL';
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-pwa-deployment.mjs https://your-app.example');
    const report = await verifyDeployment(process.argv[2]);
    report.nodeVersion = process.version;
    report.platform = process.platform;
    const root = new URL('../../', import.meta.url);
    report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    report.sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain', '--', 'html'], { cwd: root, encoding: 'utf8' }).trim());
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
