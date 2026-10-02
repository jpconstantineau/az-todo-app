import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const html = new URL('../../html/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', html), 'utf8'));

test('PWA manifest keeps a stable same-origin root identity and installation metadata', async () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name.trim());
  assert.ok(manifest.short_name.trim());
  for (const color of [manifest.theme_color, manifest.background_color]) {
    assert.match(color, /^#[0-9a-f]{6}$/i);
  }
  for (const size of [192, 512]) {
    assert.ok(manifest.icons.some(icon =>
      icon.sizes === `${size}x${size}` && icon.purpose.split(' ').includes('any')));
  }
  assert.ok(manifest.icons.some(icon => icon.purpose.split(' ').includes('maskable')));
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png');
    assert.match(icon.src, /^\/icons\/[a-z0-9-]+\.png$/);
    await readFile(new URL(icon.src.slice(1), html));
  }
});

test('PWA PNGs decode at advertised sizes; maskable artwork stays inside its safe circle', async t => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const icons = [...manifest.icons, {
    src: '/icons/apple-touch-icon.png', sizes: '180x180', purpose: 'any'
  }];
  for (const icon of icons) {
    const bytes = await readFile(new URL(icon.src.slice(1), html));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const actual = await page.evaluate(async ({ data, maskable }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + data;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = true;
      let foreground = 0;
      let outsideSafeCircle = 0;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4;
          if (pixels[offset + 3] !== 255) opaque = false;
          if (pixels[offset] || pixels[offset + 1] || pixels[offset + 2]) {
            foreground++;
            if (maskable && Math.hypot(x + .5 - canvas.width / 2, y + .5 - canvas.height / 2) > canvas.width * .4) {
              outsideSafeCircle++;
            }
          }
        }
      }
      return { sizes: `${canvas.width}x${canvas.height}`, opaque, foreground, outsideSafeCircle };
    }, { data: bytes.toString('base64'), maskable: icon.purpose.split(' ').includes('maskable') });
    assert.equal(actual.sizes, icon.sizes, icon.src);
    assert.equal(actual.opaque, true, `${icon.src} must have an opaque background`);
    assert.ok(actual.foreground > 0, `${icon.src} must not be blank`);
    assert.equal(actual.outsideSafeCircle, 0, `${icon.src} artwork must survive platform masks`);
  }
});
