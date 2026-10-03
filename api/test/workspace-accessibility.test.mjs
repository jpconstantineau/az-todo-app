import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';

async function setup(t) {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
  await context.setOffline(true);
  await page.locator('#manageWorkspaces').click();
  return { page, context, setUser: value => { user = value; } };
}
async function create(page, title) {
  await page.locator('#createWorkspace input').fill(title);
  await page.locator('#createWorkspace button').click();
  await page.waitForFunction(() => !document.querySelector('#createWorkspace button').disabled);
  return page.locator('#workspaceEntries [data-focus-key]').last().getAttribute('data-focus-key').then(key => key.split(':')[1]);
}
const focus = (page, selector) => page.waitForFunction(selector => document.activeElement.matches(selector), selector, { timeout: 5000 });
async function refresh(page) {
  await page.evaluate(() => {
    window.oldControl = document.activeElement;
    const channel = new BroadcastChannel('todo-inbox'); channel.postMessage('changed'); channel.close();
  });
  await page.waitForFunction(() => !window.oldControl.isConnected);
}

test('workspace keyboard focus survives background refresh, duplicate names and rename', { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  await create(page, 'Work'); const id = await create(page, 'Work');
  const rename = `[data-focus-key="workspace:${id}:Rename"]`;
  await page.locator(rename).focus(); await refresh(page); await focus(page, rename);
  page.once('dialog', dialog => dialog.accept('Volunteering'));
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Rename workspace: Volunteering', exact: true }).waitFor();
  await focus(page, rename);
  await page.keyboard.press('Escape'); await focus(page, '#manageWorkspaces');
});

test('archive toggle keeps its control and delete/restore focus the same workspace result', { timeout: 30000 }, async t => {
  const { page } = await setup(t); const id = await create(page, 'Family');
  const archive = page.getByRole('button', { name: 'Archive workspace: Family', exact: true });
  await archive.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Unarchive workspace: Family', exact: true }).waitFor();
  await focus(page, `[aria-label="Unarchive workspace: Family"]`);
  await page.keyboard.press('Enter'); await focus(page, '[aria-label="Archive workspace: Family"]');
  await page.getByRole('button', { name: 'Delete workspace: Family', exact: true }).focus();
  page.once('dialog', dialog => dialog.accept()); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Restore workspace: Family', exact: true }).waitFor();
  await focus(page, `[data-focus-key="workspace:${id}:heading"]`);
  assert.match(await page.locator('#workspaceEntries p').textContent(), /Deleted/);
  await page.keyboard.press('Tab'); await focus(page, '[aria-label="Restore workspace: Family"]');
  await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Rename workspace: Family', exact: true }).waitFor();
  await focus(page, `[data-focus-key="workspace:${id}:heading"]`);
});

test('a delayed workspace create preserves a later focus choice and newly typed name', { timeout: 30000 }, async t => {
  const { page } = await setup(t);
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
      const delay = this.mode === 'readwrite' && window.delayWorkspaceSave;
      if (delay) window.delayWorkspaceSave = false;
      descriptor.set.call(this, delay ? function (event) { window.releaseWorkspaceSave = () => callback.call(this, event); } : callback);
    } });
  });
  await page.locator('#createWorkspace input').fill('Work');
  await page.evaluate(() => { window.delayWorkspaceSave = true; });
  await page.locator('#createWorkspace button').click();
  await page.waitForFunction(() => !!window.releaseWorkspaceSave);
  await page.locator('#createWorkspace input').fill('Next workspace');
  await page.locator('#closeWorkspaces').focus();
  await page.evaluate(() => { releaseWorkspaceSave(); });
  await page.waitForFunction(() => !document.querySelector('#createWorkspace button').disabled);
  assert.equal(await page.locator('#createWorkspace input').inputValue(), 'Next workspace');
  await focus(page, '#closeWorkspaces');
  await page.keyboard.press('Enter'); await focus(page, '#manageWorkspaces');
  await page.locator('#manageWorkspaces').click();
  await page.locator('#createWorkspace input').fill('Family');
  await page.evaluate(() => { window.delayWorkspaceSave = true; window.releaseWorkspaceSave = null; });
  await page.locator('#createWorkspace button').click();
  await page.waitForFunction(() => !!window.releaseWorkspaceSave);
  await page.keyboard.press('Escape'); await focus(page, '#manageWorkspaces');
  await page.locator('#captureText').focus();
  await page.evaluate(() => releaseWorkspaceSave());
  await page.waitForFunction(() => !document.querySelector('#createWorkspace button').disabled);
  await focus(page, '#captureText');
});

test('a previous account workspace save cannot reset the current account form', { timeout: 30000 }, async t => {
  const { page, context, setUser } = await setup(t);
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    let delay = true;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(callback) {
      const hold = this.mode === 'readwrite' && delay;
      if (hold) delay = false;
      descriptor.set.call(this, hold ? function (event) { window.releasePreviousSave = () => callback.call(this, event); } : callback);
    } });
  });
  await page.locator('#createWorkspace input').fill('Old account name');
  await page.locator('#createWorkspace button').click();
  await page.waitForFunction(() => !!window.releasePreviousSave);
  setUser('bob'); await context.setOffline(false);
  await page.locator('#workspaceManager').waitFor({ state: 'hidden' });
  await page.locator('#workspace').waitFor();
  await page.locator('#manageWorkspaces').click();
  await page.locator('#createWorkspace input').fill('New account name');
  await page.locator('#closeWorkspaces').focus();
  await page.evaluate(() => releasePreviousSave());
  await page.waitForFunction(() => !document.querySelector('#createWorkspace button').disabled);
  assert.equal(await page.locator('#createWorkspace input').inputValue(), 'New account name');
  await focus(page, '#closeWorkspaces');
  assert.equal(await page.locator('#workspaceEntries article').count(), 0);
});
