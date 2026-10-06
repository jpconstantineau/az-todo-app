import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { showView, clickControl } from './navigation-helper.mjs';

const synced = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

test('task rows keep actions visible at every width and retain keyboard focus, recovery and immediate undo', { timeout: 90000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await synced(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  const longTitle = 'Plan the garage shelving with measurements, materials, delivery and enough room for every tool '.repeat(2).trim();
  await page.locator('#captureText').fill([longTitle, 'Milk', 'Bread'].join('\n'));
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === ''); await synced(page);
  await showView(page, 'work'); await page.locator('#view').selectOption('all');
  const cards = page.locator('#items article');
  assert.equal(await cards.count(), 3);
  assert.ok((await cards.locator('.record-state').allTextContents()).every(text => !text.includes('Server-confirmed')));
  if (process.env.TASK_MENU_SCREENSHOTS) await mkdir(process.env.TASK_MENU_SCREENSHOTS, { recursive: true });
  for (const width of [767, 768, 936, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator('.task-menu').count(), 0);
    assert.equal(await cards.locator('button:visible').count(), 15, 'title and four actions are exposed for every task');
    for (const [name, title] of [[`Complete ${longTitle}`, 'Complete'], [`Clarify ${longTitle}`, 'Clarify'], [`Brief ${longTitle}`, 'Brief'], [`Delete item: ${longTitle}`, 'Delete']]) {
      const action = page.getByRole('button', { name, exact: true });
      assert.equal(await action.isVisible(), true, name);
      assert.equal(await action.getAttribute('title'), title);
      assert.equal(await action.locator('svg[aria-hidden=true]').count(), 1);
    }
    assert.ok(await cards.locator('.task-actions button').evaluateAll(controls => controls.every(control => {
      const bounds = control.getBoundingClientRect(); return bounds.width >= 44 && bounds.height >= 44;
    })));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const clarify = page.getByRole('button', { name: `Clarify ${longTitle}`, exact: true });
    await clarify.focus();
    await page.evaluate(() => { window.beforeRefresh = document.activeElement; const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close(); });
    await page.waitForFunction(() => !window.beforeRefresh.isConnected);
    assert.equal(await clarify.evaluate(el => el === document.activeElement), true);
    if (process.env.TASK_MENU_SCREENSHOTS) await page.screenshot({ path: `${process.env.TASK_MENU_SCREENSHOTS}/tasks-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 767, height: 900 });
  await page.setViewportSize({ width: 936, height: 900 });
  const brief = page.getByRole('button', { name: `Brief ${longTitle}`, exact: true });
  await brief.click();
  await page.locator('#closeBriefs').click();
  assert.equal(await brief.evaluate(el => el === document.activeElement), true);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete Milk', exact: true }).click();
  await page.getByRole('button', { name: 'Complete Milk', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('#undoTaskChange').waitFor();
  assert.match(await page.locator('#recentTaskChangeStatus').textContent(), /Completed “Milk”/);
  await page.locator('#undoTaskChange').click();
  await page.getByRole('button', { name: 'Complete Milk', exact: true }).waitFor();
  assert.equal(await page.locator('#recentTaskChange').isVisible(), false);
  assert.match(await cards.filter({ hasText: 'Milk' }).locator('.record-state').textContent(), /pending/);
  assert.equal(await cards.locator('button:visible').count(), 16, 'historical Undo stays visible on its task');
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Undo state change Milk', exact: true }));
  await page.getByRole('button', { name: 'Complete Milk', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('#statusFilter').selectOption('completed');
  await page.getByRole('button', { name: 'Reopen Milk', exact: true }).click();
  await page.locator('#undoTaskChange').waitFor();
  assert.match(await page.locator('#recentTaskChangeStatus').textContent(), /Reopened “Milk”/);
  await page.locator('#undoTaskChange').click();
  await page.getByRole('button', { name: 'Reopen Milk', exact: true }).waitFor();
  await context.setOffline(false); await clickControl(page.locator('#sync')); await synced(page);
  await page.locator('#statusFilter').selectOption('');
  await page.getByRole('button', { name: 'Complete Bread', exact: true }).click();
  await page.locator('#undoTaskChange').waitFor(); await synced(page);
  assert.equal(await page.locator('#recentTaskChange').isVisible(), true, 'server confirmation preserves immediate undo');
  await page.locator('#undoTaskChange').click();
  await page.getByRole('button', { name: 'Complete Bread', exact: true }).waitFor(); await synced(page);
  // A rejected save stays on its task even when a later offline change is queued.
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Complete Bread', exact: true }).click();
  await page.locator('#undoTaskChange').waitFor();
  await page.locator('#statusFilter').selectOption('@all');
  await page.getByRole('button', { name: 'Reopen Bread', exact: true }).click();
  await page.getByRole('button', { name: 'Complete Bread', exact: true }).waitFor();
  await page.evaluate(async () => {
    const { transact } = await import('/inbox-store.js?v=7');
    await transact('alice', local => {
      const entry = local.queue[0], mutation = entry.operation.mutations[0];
      entry.failure = 'Conflict — inspect the server version';
      // A concurrent server edit may have the same version as our optimistic save.
      local.records['item:' + mutation.id].version = mutation.expectedVersion + 1;
    });
    const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close();
  });
  await page.locator('#failure').waitFor();
  await page.locator('#statusFilter').selectOption('@all');
  assert.match(await cards.filter({ hasText: 'Bread' }).locator('.record-state').textContent(), /Failed — needs attention/);
  assert.equal(await page.locator('#recentTaskChange').isVisible(), false);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#discard').click();
  await page.locator('#failure').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#recentTaskChange').isVisible(), false, 'discarding a conflict cannot revive stale immediate undo');
  await page.getByRole('button', { name: `Complete ${longTitle}`, exact: true }).click();
  await page.locator('#undoTaskChange').waitFor();
  user = null; await context.setOffline(false); // Reconnection automatically checks the session.
  await page.locator('#workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#recentTaskChangeStatus').textContent(), '', 'expired sessions clear private undo text');
  assert.deepEqual(errors, []);
});
