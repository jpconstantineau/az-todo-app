import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { clickControl, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const sync = async page => { await clickControl(page.locator('#sync')); await confirmed(page); };
const local = page => page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
const trash = page => clickControl(page.locator('#openDeleted'));

test('deletion: offline reload, parent recovery, another device conflict and account isolation', { timeout: 90000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const other = await browser.newContext();
  const page = await context.newPage(), second = await other.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept()); second.on('dialog', dialog => dialog.accept());
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent.includes('Ready to reopen'));
  const seeded = await page.evaluate(async () => {
    const response = await fetch('/api/v1/operations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      apiVersion: 1, accountId: 'alice', operationId: 'deletion-fixture', mutations: [
        { type: 'list', id: 'list', action: 'create', expectedVersion: 0, fields: { title: 'Groceries' } },
        { type: 'project', id: 'project', action: 'create', expectedVersion: 0, fields: { title: 'Breakfast', outcome: 'Ready for breakfast' } },
        { type: 'item', id: 'milk', action: 'create', expectedVersion: 0, fields: { title: 'Milk', originalText: '  Milk\n', listId: 'list', projectId: 'project' } }
      ] }) }); return response.status;
  });
  assert.equal(seeded, 200); await sync(page);
  await waitForBrowser(page, async () => !!(await (await import('/inbox-store.js')).transact('alice')).records['item:milk']);
  await second.goto(server.url); await second.locator('#workspace').waitFor(); await confirmed(second);
  await showView(second, 'work'); await other.setOffline(true);
  await second.getByRole('button', { name: 'Edit Milk', exact: true }).click();
  await second.locator('#edit [name=title]').fill('Keep this offline text');
  await second.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await second.locator('#editor').waitFor({ state: 'hidden' });

  await showView(page, 'lists'); await page.locator('#view').selectOption('list');
  await page.getByRole('button', { name: 'Delete list: Groceries', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Move or delete'));
  assert.match(await page.locator('#error').textContent(), /Move or delete/);
  assert.equal((await local(page)).queue.length, 0);
  await clickControl(page.getByRole('button', { name: 'Delete item: Milk', exact: true, includeHidden: true }));
  await page.getByRole('button', { name: 'Delete item: Milk', exact: true }).waitFor({ state: 'hidden' });
  await confirmed(page);
  await other.setOffline(false); await clickControl(second.locator('#sync')); await second.locator('#failure').waitFor();
  assert.match(await second.locator('#comparison').textContent(), /Keep this offline text/);
  assert.equal(await second.locator('#items article').count(), 0);
  assert.equal((await local(second)).undoEdit, undefined, 'remote deletion invalidates edit undo');
  await second.locator('#discard').click(); await confirmed(second);

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Delete list: Groceries', exact: true }).click();
  await page.getByRole('button', { name: 'Delete list: Groceries', exact: true }).waitFor({ state: 'hidden' });
  await showView(page, 'work'); await page.locator('#view').selectOption('project:project');
  await page.getByRole('button', { name: 'Delete project: Breakfast', exact: true }).click();
  await page.getByRole('button', { name: 'Delete project: Breakfast', exact: true }).waitFor({ state: 'hidden' });
  await page.reload(); await page.locator('#workspace').waitFor(); await trash(page);
  assert.equal(await page.locator('#deletedItems article').count(), 3);
  await page.getByRole('button', { name: 'Restore item: Milk', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#deletedError').textContent.includes('list first'));
  await page.getByRole('button', { name: 'Restore list: Groceries', exact: true }).click();
  await page.getByRole('button', { name: 'Restore list: Groceries', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Restore item: Milk', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#deletedError').textContent.includes('project first'));
  await page.getByRole('button', { name: 'Restore project: Breakfast', exact: true }).click();
  await page.getByRole('button', { name: 'Restore project: Breakfast', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Restore item: Milk', exact: true }).click();
  await page.getByRole('button', { name: 'Restore item: Milk', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#deletedRecords').contains(document.activeElement));
  await page.locator('#closeDeleted').click(); await page.reload(); await page.locator('#workspace').waitFor();
  await showView(page, 'work'); await page.locator('#view').selectOption('all');
  await page.getByRole('button', { name: 'Edit Milk', exact: true }).waitFor();
  assert.equal((await local(page)).queue.length, 5);
  await context.setOffline(false); await sync(page);
  const restored = documents.find(doc => doc.kind === 'record' && doc.record.id === 'milk').record;
  assert.equal(restored.deleted, false); assert.equal(restored.originalText, '  Milk\n');
  assert.equal(restored.version, 3); assert.equal(restored.listId, 'list'); assert.equal(restored.projectId, 'project');
  await sync(second); await second.getByRole('button', { name: 'Edit Milk', exact: true }).waitFor();
  assert.equal(documents.filter(doc => doc.kind === 'record' && doc.record.type === 'item').length, 1);

  await clickControl(page.getByRole('button', { name: 'Delete item: Milk', exact: true, includeHidden: true }));
  await page.getByRole('button', { name: 'Delete item: Milk', exact: true }).waitFor({ state: 'hidden' });
  await confirmed(page); await trash(page);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.locator('#deletedRecords').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
      if (process.env.DELETION_SCREENSHOTS) {
        await mkdir(process.env.DELETION_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.DELETION_SCREENSHOTS}/deleted-${theme}-${width}.png` });
      }
    }
  }
  user = 'bob';
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.locator('#deletedRecords').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#deletedItems article').count(), 0);
  await page.reload(); await page.locator('#workspace').waitFor(); await trash(page);
  assert.equal(await page.locator('#deletedItems article').count(), 0);
  assert.deepEqual(errors, []);
});
