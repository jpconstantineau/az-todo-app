import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { showView, clickControl } from './navigation-helper.mjs';
import { currentCreate } from './current-record.mjs';

const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=6')).transact('alice'));
const synced = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
async function setup(t, ai = false, seeds = []) {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  for (let start = 0; start < seeds.length; start += 20) {
    const response = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: `workspace-move-seed-${start / 20}`, mutations: seeds.slice(start, start + 20) }) });
    assert.equal(response.status, 200, await response.text());
  }
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (ai) await context.addInitScript(() => {
    globalThis.LanguageModel = {
      availability: async () => 'available',
      create: async () => ({ destroy() {}, prompt: () => new Promise(resolve => { window.finishWorkspaceAI = resolve; }) })
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await synced(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  return { page, context, server, setUser: value => { user = value; } };
}
const create = currentCreate;
async function createSpace(page, title) {
  await clickControl(page.locator('#manageWorkspaces'));
  await page.locator('#createWorkspace input').fill(title);
  await page.locator('#createWorkspace button').click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click();
  return page.locator('#workspaceSelect option').evaluateAll((options, title) => options.find(option => option.textContent === title).value, title);
}
async function switchTo(page, id) {
  await page.locator('#workspaceSelect').selectOption(id);
  await waitForBrowser(page, async id => (await (await import('/inbox-store.js?v=6')).transact('alice')).selectedWorkspace === id, id);
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
  await page.locator('#closeReviews').click(); await showView(page, 'work');
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

test('workspaces: list move carries a nested project and clarified item through offline save and sync', async t => {
  const { page, context } = await setup(t, false, [
    create('workspace', 'work', { title: 'Work' }), create('workspace', 'family', { title: 'Family' }),
    create('list', 'root', { title: 'Root', workspaceId: 'work' }),
    create('project', 'child', { title: 'Child', outcome: 'Done', workspaceId: 'work', parentRef: { type: 'list', id: 'root' } }),
    create('item', 'task', { title: 'Clarified task', originalText: 'Original task', workspaceId: 'work', projectId: 'child' })
  ]);
  await switchTo(page, 'work'); await showView(page, 'lists'); await page.locator('#view').selectOption('root');
  await page.getByRole('button', { name: 'Edit list: Root' }).click();
  await context.setOffline(true);
  await page.locator('#edit [name=workspaceId]').selectOption('family');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  const saved = await local(page);
  assert.deepEqual(saved.queue[0].operation.mutations.map(mutation => `${mutation.type}:${mutation.id}`).sort(), ['item:task', 'list:root', 'project:child']);
  await page.reload(); await page.locator('#workspace').waitFor();
  await switchTo(page, 'family'); await showView(page, 'lists'); await page.locator('#view').selectOption('root');
  await page.locator('#includeNested').check();
  await page.getByRole('button', { name: 'Edit Clarified task' }).waitFor();
  await context.setOffline(false); await clickControl(page.locator('#sync')); await synced(page);
  assert.equal(documents.find(row => row.id === 'record:item:task').record.originalText, 'Original task');
  assert.equal(documents.find(row => row.id === 'record:item:task').record.workspaceId, 'family');
});

test('workspaces: large list move survives offline reload and a lost acknowledgement without restarting', { timeout: 90000 }, async t => {
  const seeds = [
    create('workspace', 'work', { title: 'Work' }), create('workspace', 'family', { title: 'Family' }),
    create('list', 'root', { title: 'Root', workspaceId: 'work' }), create('list', 'other', { title: 'Other', workspaceId: 'work' }),
    ...Array.from({ length: 21 }, (_, index) => create('item', `task-${index}`, { title: `Task ${index}`, originalText: `Original ${index}`,
      workspaceId: 'work', listId: 'other', collectionRefs: [{ type: 'list', id: 'root' }, { type: 'list', id: 'other' }] }))
  ];
  const { page, context } = await setup(t, false, seeds);
  await switchTo(page, 'work'); await showView(page, 'lists'); await page.locator('#view').selectOption('root');
  await page.getByRole('button', { name: 'Edit list: Root' }).click();
  await context.setOffline(true);
  await page.locator('#edit [name=workspaceId]').selectOption('family');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  let saved = await local(page);
  assert.equal(saved.workspaceMove.entries.length, 22);
  assert.equal(saved.queue.length, 1);
  assert.equal(saved.queue[0].workspaceMovePhase, 'detach');
  assert.ok(saved.queue[0].operation.mutations.length <= 20);
  await page.reload(); await page.locator('#workspace').waitFor();
  saved = await local(page);
  assert.equal(saved.workspaceMove.id.length > 0, true);
  await switchTo(page, 'family'); await showView(page, 'lists'); await page.locator('#view').selectOption('root');
  assert.equal(await page.locator('#items article').count(), 21, 'the initiating device projects the complete destination tree');

  faults.loseBatchResponse = true;
  await context.setOffline(false); await clickControl(page.locator('#sync'));
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Sync paused'));
  await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=6')).transact('alice');
    return !state.workspaceMove && state.queue.length === 0 && state.records['item:task-20']?.workspaceId === 'family';
  });
  await synced(page);
  const moved = documents.filter(row => row.kind === 'record' && row.record.type === 'item').map(row => row.record);
  assert.equal(moved.length, 21);
  for (const item of moved) {
    assert.equal(item.workspaceId, 'family');
    assert.deepEqual(item.collectionRefs, [{ type: 'list', id: 'root' }]);
    assert.match(item.originalText, /^Original /);
  }
  assert.equal(documents.find(row => row.id === 'record:list:other').record.workspaceId, 'work');
});

test('workspaces: large move pauses on a concurrent edit and resumes without overwriting it', { timeout: 90000 }, async t => {
  const seeds = [
    create('workspace', 'work', { title: 'Work' }), create('workspace', 'family', { title: 'Family' }),
    create('list', 'root', { title: 'Root', workspaceId: 'work' }),
    ...Array.from({ length: 21 }, (_, index) => create('item', `task-${index}`, { title: `Task ${index}`, workspaceId: 'work',
      listId: 'root', collectionRefs: [{ type: 'list', id: 'root' }] }))
  ];
  const { page, context, server } = await setup(t, false, seeds);
  await switchTo(page, 'work'); await showView(page, 'lists'); await page.locator('#view').selectOption('root');
  await page.getByRole('button', { name: 'Edit list: Root' }).click(); await context.setOffline(true);
  await page.locator('#edit [name=workspaceId]').selectOption('family');
  await page.getByRole('button', { name: 'Save edit on device' }).click();
  const changed = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: 'concurrent-move-edit',
      mutations: [{ type: 'item', id: 'task-0', action: 'update', expectedVersion: 1, fields: { title: 'Concurrent title' } }] }) });
  assert.equal(changed.status, 200);
  await context.setOffline(false); await clickControl(page.locator('#sync'));
  await page.locator('#failure').waitFor();
  assert.equal(await page.locator('#resumeMove').isVisible(), true);
  assert.equal((await local(page)).workspaceMove.phase, 'detach');
  await page.locator('#resumeMove').click();
  await waitForBrowser(page, async () => {
    const state = await (await import('/inbox-store.js?v=6')).transact('alice');
    return !state.workspaceMove && state.queue.length === 0;
  });
  await synced(page);
  const item = documents.find(row => row.id === 'record:item:task-0').record;
  assert.equal(item.title, 'Concurrent title');
  assert.equal(item.workspaceId, 'family');
  assert.deepEqual(item.collectionRefs, [{ type: 'list', id: 'root' }]);
});

test('workspaces: AI capture cancels on switching and restored reviewed batches keep their original workspace', { timeout: 60000 }, async t => {
  const { page } = await setup(t, true);
  const work = await createSpace(page, 'Work'), family = await createSpace(page, 'Family');
  await switchTo(page, work);
  await page.locator('#captureText').fill('Write report');
  await page.locator('#captureAI summary').click();
  await page.locator('#extractStart').click();
  await page.waitForFunction(() => typeof finishWorkspaceAI === 'function');
  await switchTo(page, family); await page.locator('#captureText').fill('Write report');
  const result = JSON.stringify({ items: [{ title: 'Write report', description: '', listId: '', priority: '', context: '', dueDate: '', dueTime: '', evidence: 'Write report', uncertainty: '' }], notes: '' });
  await page.evaluate(async result => { finishWorkspaceAI(result); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, result);
  assert.equal(await page.locator('#extractReview').isVisible(), false, 'same text in another workspace cannot receive the late result');
  await switchTo(page, work);
  await page.evaluate(() => { window.finishWorkspaceAI = null; });
  await page.locator('#extractStart').click(); await page.waitForFunction(() => typeof finishWorkspaceAI === 'function');
  await page.evaluate(result => finishWorkspaceAI(result), result);
  await page.locator('#extractionReview').waitFor(); await page.locator('#extractClose').click();
  await switchTo(page, family); assert.equal(await page.locator('#extractReview').isVisible(), false);
  await switchTo(page, work); await page.locator('#extractReview').click();
  await page.locator('#extractAccept').click(); await page.waitForFunction(() => !document.querySelector('#extractionReview').open);
  await synced(page);
  const items = documents.filter(row => row.kind === 'record' && row.record.type === 'item');
  assert.equal(items.length, 1); assert.equal(items[0].record.workspaceId, work);
  assert.equal((await local(page)).workspaceDrafts[family].capture.text, 'Write report');
});

test('workspaces: suggested reviews and list-name permission stay with their workspace', async t => {
  const { page, context } = await setup(t, true);
  const work = await createSpace(page, 'Work'); await synced(page);
  await switchTo(page, work); await context.setOffline(true);
  await page.locator('#captureText').fill('Prepare the report and check its figures.');
  await page.locator('#captureAI summary').click();
  await page.locator('#extractLists').check();
  await page.locator('#extractStart').click();
  await page.waitForFunction(() => typeof finishWorkspaceAI === 'function');
  const result = JSON.stringify({ items: [{ title: 'Prepare the report', description: '', listId: '', priority: '', context: '', dueDate: '', dueTime: '', evidence: 'Prepare the report', uncertainty: '' }], notes: '' });
  await page.evaluate(result => finishWorkspaceAI(result), result);
  await page.locator('#extractionReview').waitFor();
  await page.locator('#extractionItems [name=title]').fill('Prepare the report');
  await page.locator('#extractClose').click();
  await switchTo(page, 'personal');
  assert.equal(await page.locator('#extractLists').isChecked(), false);
  assert.equal(await page.locator('#extractReview').isVisible(), false);
  await switchTo(page, work); await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#extractLists').isChecked(), true);
  await clickControl(page.locator('#extractReview'));
  assert.equal(await page.locator('#extractionItems [name=title]').inputValue(), 'Prepare the report');
  await page.locator('#extractAccept').click(); await page.locator('#extractionReview').waitFor({ state: 'hidden' });
  const saved = await local(page);
  assert.equal(saved.queue.length, 1);
  assert.equal(saved.queue[0].operation.mutations[0].fields.workspaceId, work);
  assert.equal(saved.workspaceDrafts[work].extraction.includeLists, true);
  await context.setOffline(false); await clickControl(page.locator('#sync')); await synced(page);
  const items = documents.filter(row => row.kind === 'record' && row.record.type === 'item');
  assert.equal(items.length, 1); assert.equal(items[0].record.workspaceId, work);
});

test('workspaces: archive, delete, offline recovery and responsive management preserve all contents', { timeout: 90000 }, async t => {
  const { page, context } = await setup(t);
  const work = await createSpace(page, 'Work'); await switchTo(page, work);
  await capture(page, 'Preserved report'); await synced(page);
  await page.locator('#captureText').fill('Preserved draft');
  await clickControl(page.locator('#manageWorkspaces'));
  await page.getByRole('button', { name: 'Archive workspace: Work', exact: true }).click();
  await page.getByRole('button', { name: 'Unarchive workspace: Work', exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click();
  assert.equal(await page.locator('#captureText').isDisabled(), true);
  await showView(page, 'work'); assert.equal(await page.locator('#items article').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Complete Preserved report', exact: true }).isDisabled(), true);
  await showView(page, 'reviews');
  for (const id of ['startDaily', 'startWeekly', 'reviewSessions']) assert.equal(await page.locator('#' + id).isDisabled(), true);
  await clickControl(page.locator('#manageWorkspaces'));
  await page.getByRole('button', { name: 'Delete workspace: Work', exact: true }).click();
  await page.getByRole('button', { name: 'Restore workspace: Work', exact: true }).waitFor();
  await page.locator('#closeWorkspaces').click(); await synced(page);
  await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#items article').count(), 0);
  await switchTo(page, 'personal');
  assert.equal((await local(page)).workspaceDrafts[work].capture.text, 'Preserved draft');
  await clickControl(page.locator('#manageWorkspaces'));
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
  await clickControl(page.locator('#manageWorkspaces'));
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
  await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => !!(await (await import('/inbox-store.js?v=6')).transact('alice')).queue[0]?.failure);
  await page.locator('#failure').waitFor();
  const retained = await local(page);
  assert.deepEqual(retained.queue[0].operation, intent);
  assert.match(retained.queue[0].failure, /workspace.*unavailable or archived/i);
  assert.equal(documents.filter(row => row.kind === 'record' && row.record.type === 'item').length, 0);
  assert.equal(await page.locator('#capture').isVisible(), false);
  await switchTo(page, 'personal'); await capture(page, 'Unrelated Personal work');
  assert.equal((await local(page)).queue.length, 2, 'blocked queue preserves later work without assigning it to the deleted space');
  const copy = await page.evaluate(async () => {
    const { deviceExport, readableExport } = await import('/inbox-export.js?v=5');
    const state = await (await import('/inbox-store.js?v=6')).transact('alice');
    return readableExport(deviceExport('alice', state, {}));
  });
  assert.match(copy, /Recover this offline report/);
  assert.match(copy, /Unrelated Personal work/);
});
