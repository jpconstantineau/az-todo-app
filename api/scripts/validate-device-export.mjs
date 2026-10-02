import { readFile, writeFile } from 'node:fs/promises';
import { validateDeviceExport } from '../../html/inbox-export.js';

// Offline validation/round-trip only. Never connects to Azure or replays a queue.
try {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error('Usage: node scripts/validate-device-export.mjs input.json [roundtrip-output.json]');
  const value = JSON.parse(await readFile(input, 'utf8'));
  const report = validateDeviceExport(value);
  if (output) await writeFile(output, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...report, roundTripWritten: !!output, liveRestore: false }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
