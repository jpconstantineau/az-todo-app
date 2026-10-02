// Run from api/: node scripts/generate-pwa-icons.mjs
// Uses the existing Playwright dependency; generated PNGs are committed assets.
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const icons = new URL('../../html/icons/', import.meta.url);
const svg = await readFile(new URL('icon.svg', icons), 'utf8');
await mkdir(icons, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [size, filename] of [[192, 'icon-192.png'], [512, 'icon-512.png'], [180, 'apple-touch-icon.png']]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>' + svg);
    await page.screenshot({ path: fileURLToPath(new URL(filename, icons)) });
  }
} finally {
  await browser.close();
}
