import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { showView, clickControl } from './navigation-helper.mjs';

const local = page => page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
const synced = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
async function setup(t) {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await synced(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  return { page, context, server, setUser: value => { user = value; } };
}
async function createSpace(page, title) {
  await page.locator('#manageWorkspaces').click();
  await page.locator('#createWorkspace input').fill(title);
  await page.locator('#createWorkspace button').click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click();
  return page.locator('#workspaceSelect option').evaluateAll((options, title) => options.find(option => option.textContent === title).value, title);
}
async function switchTo(page, id) {
  await page.locator('#workspaceSelect').selectOption(id);
  await waitForBrowser(page, async id => (await (await import('/inbox-store.js')).transact('alice')).selectedWorkspace === id, id);
}
async function capture(page, text) {
  await showView(page, 'capture'); await page.locator('#captureText').fill(text);
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
}

test('workspaces: offline drafts, filters, capture, reviews, moves, reload and account isolation', { timeout: 90000 }, async t => {
  const { page, context, setUser } = await setup(t);
  await capture(page, 'Personal milk'); await synced(page);
  const work = await createSpace(page, 'Work'), family = await createSpace(page, 'Family'); await synced(page);
  await page.locator('#captureText').fill('Personal unsent draft');
  await switchTo(page, work); assert.equal(await page.locator('#captureText').inputValue(), '');
  await context.setOffline(true);
  await capture(page, 'Work report');
  await page.locator('#captureText').fill('Work unsent draft');
  await showView(page, 'work'); await page.locator('#statusFilter').selectOption('@all');
  assert.equal(await page.locator('#items article').count(), 1);
  await switchTo(page, family); assert.equal(await page.locator('#items article').count(), 0);
  await capture(page, 'Family dinner');
  await switchTo(page, work); await showView(page, 'capture');
  assert.equal(await page.locator('#captureText').inputValue(), 'Work unsent draft');
  const before = await local(page);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#workspaceSelect').inputValue(), work);
  assert.equal(await page.locator('#captureText').inputValue(), 'Work unsent draft');
  assert.deepEqual((await local(page)).queue, before.queue);
  await showView(page, 'work'); assert.equal(await page.locator('#statusFilter').inputValue(), '@all');
  await clickControl(page.locator('#openReviews'));
  await page.locator('#startWeekly').click(); await page.locator('#reviewBody').waitFor();
  assert.match(await page.locator('#reviewTitle').innerText(), /Work report/);
  assert.equal(await page.locator('#reviewRecord option').count(), 1);
  await page.locator('#closeReviews').click();
  await page.getByRole('button', { name: 'Edit Work report', exact: true }).click();
  await page.locator('#edit [name=workspaceId]').selectOption(family);
  await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#editor').open);
  assert.equal(await page.locator('#items article').count(), 0);
  await switchTo(page, family); await showView(page, 'work');
  assert.equal(await page.locator('#items article').count(), 2);
  await switchTo(page, 'personal'); await showView(page, 'capture');
  assert.equal(await page.locator('#captureText').inputValue(), 'Personal unsent draft');
  await context.setOffline(false); await clickControl(page.locator('#sync')); await synced(page);
  assert.equal(documents.filter(row => row.kind === 'record' && row.record.type === 'item').length, 3);
  setUser('bob'); await page.reload(); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#workspaceSelect').options.length === 1);
  assert.equal(await page.locator('#captureText').inputValue(), '');
  assert.equal(await page.locator('#workspaceSelect').inputValue(), 'personal');
});

test('workspaces: archive, delete, offline recovery and responsive management preserve all contents', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  const work = await createSpace(page, 'Work'); await switchTo(page, work);
  await capture(page, 'Preserved report'); await synced(page);
  await page.locator('#captureText').fill('Preserved draft');
  await page.locator('#manageWorkspaces').click();
  await page.getByRole('button', { name: 'Archive workspace: Work', exact: true }).click();
  await page.getByRole('button', { name: 'Unarchive workspace: Work', exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click();
  assert.equal(await page.locator('#captureText').isDisabled(), true);
  await showView(page, 'work'); assert.equal(await page.locator('#items article').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Complete Preserved report', exact: true }).isDisabled(), true);
  await page.locator('#manageWorkspaces').click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete workspace: Work', exact: true }).click();
  await page.getByRole('button', { name: 'Restore workspace: Work', exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click(); await synced(page);
  await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#items article').count(), 0);
  await switchTo(page, 'personal');
  assert.equal((await local(page)).workspaceDrafts[work].capture.text, 'Preserved draft');
  await page.locator('#manageWorkspaces').click();
  await page.getByRole('button', { name: 'Restore workspace: Work', exact: true }).click();
  await page.getByRole('button', { name: 'Unarchive workspace: Work', exact: true }).click();
  await page.getByRole('button', { name: 'Archive workspace: Work', exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click(); await switchTo(page, work); await showView(page, 'capture');
  assert.equal(await page.locator('#captureText').inputValue(), 'Preserved draft');
  assert.equal(await page.locator('#captureText').isDisabled(), false);
  await showView(page, 'work'); assert.equal(await page.locator('#items article').count(), 1);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.WORKSPACE_SCREENSHOTS) {
      await mkdir(process.env.WORKSPACE_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.WORKSPACE_SCREENSHOTS}/workspaces-${width}.png`, fullPage: true });
    }
  }
  await page.locator('#manageWorkspaces').click();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.locator('#workspaceManager').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
      if (process.env.WORKSPACE_SCREENSHOTS) await page.screenshot({ path: `${process.env.WORKSPACE_SCREENSHOTS}/manager-${theme}-${width}.png` });
    }
  }
  await page.locator('#closeWorkspaces').click();
  await context.setOffline(false); await clickControl(page.locator('#sync')); await synced(page);
  assert.equal(documents.find(row => row.kind === 'record' && row.record.type === 'item').record.title, 'Preserved report');
});

test('workspaces: another device deletes a workspace while offline capture keeps its rejected intent for recovery', { timeout: 60000 }, async t => {
  const { page, context, server } = await setup(t);
  const work = await createSpace(page, 'Work'); await switchTo(page, work); await synced(page);
  const saved = Object.values((await local(page)).records).find(record => record.type === 'workspace');
  await context.setOffline(true); await capture(page, 'Recover this offline report');
  const intent = (await local(page)).queue[0].operation;
  const deleted = await fetch(server.url + '/api/v1/operations', {
    method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: 'other-device-delete',
      mutations: [{ type: 'workspace', id: work, action: 'delete', expectedVersion: saved.version }] })
  });
  assert.equal(deleted.status, 200);
  await context.setOffline(false);
  await page.locator('#failure').waitFor();
  const retained = await local(page);
  assert.deepEqual(retained.queue[0].operation, intent);
  assert.match(retained.queue[0].failure, /workspace.*unavailable or archived/i);
  assert.equal(documents.filter(row => row.kind === 'record' && row.record.type === 'item').length, 0);
  assert.equal(await page.locator('#capture').isVisible(), false);
  await switchTo(page, 'personal'); await capture(page, 'Unrelated Personal work');
  assert.equal((await local(page)).queue.length, 2, 'blocked queue preserves later work without assigning it to the deleted space');
  const copy = await page.evaluate(async () => {
    const { deviceExport, readableExport } = await import('/inbox-export.js');
    const state = await (await import('/inbox-store.js')).transact('alice');
    return readableExport(deviceExport('alice', state, {}));
  });
  assert.match(copy, /Recover this offline report/);
  assert.match(copy, /Unrelated Personal work/);
});
