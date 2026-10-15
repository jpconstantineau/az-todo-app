import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { currentCreate } from './current-record.mjs';
import { showView, clickControl } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';

const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

test('project faces stay consistent across views, filters and offline lifecycle changes', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const seeded = await fetch(server.url + '/api/v1/operations', { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' },
    body: JSON.stringify({ apiVersion: 1, accountId: 'alice', operationId: crypto.randomUUID(), mutations: [
      currentCreate('list', 'parent', { title: 'Home', kind: 'area' }),
      currentCreate('project', 'project', { title: 'Trip', outcome: 'Ready to travel', parentRef: { type: 'list', id: 'parent' } }),
      currentCreate('item', 'task', { title: 'Book tickets', status: 'waiting', waitingOn: 'Dates', projectId: 'project' })
    ] }) });
  assert.equal(seeded.status, 200, await seeded.text());
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await showView(page, 'reviews'); await page.locator('#startWeekly').click();
  await page.locator('#reviewRecord option').first().waitFor({ state: 'attached' }); await confirmed(page);
  const reviewIndex = await page.locator('#reviewRecord option').evaluateAll(options => options.find(option => option.textContent.includes('Trip')).value);
  await page.locator('#reviewRecord').selectOption(reviewIndex);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await showView(page, 'plan'); await page.locator('#planHierarchy details > summary').click();
  await page.getByRole('button', { name: 'Plan Trip', exact: true }).focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#planFocus').inputValue(), 'project:project');
  await page.setViewportSize({ width: 390, height: 844 });
  const checkViews = async (face, explanation) => {
    const text = `Project: ${face} Trip — ${explanation} (`;
    await showView(page, 'plan');
    const planButton = page.locator('#planHierarchy button[aria-label="Plan Trip"]');
    assert.ok((await planButton.textContent()).startsWith(text));
    assert.ok((await planButton.getAttribute('title')).includes(explanation));
    assert.ok((await planButton.getAttribute('aria-description')).includes(explanation));
    await clickControl(page.locator('#planFocus')); await page.locator('#planFocus').selectOption('project:project');
    assert.equal(await page.locator('#planFocus').inputValue(), 'project:project');
    assert.ok((await page.locator('#planFocus option:checked').textContent()).includes(`${face} Trip — ${explanation}`));
    await showView(page, 'lists');
    await page.locator('#view').selectOption('parent');
    const child = page.locator('#collectionChildren button');
    assert.ok((await child.textContent()).startsWith(text));
    assert.ok((await child.getAttribute('title')).includes(explanation));
    assert.ok((await page.locator('#collectionOutline').textContent()).includes(`${face} Trip — ${explanation}`));
    await page.locator('#view').selectOption('project:project');
    assert.ok((await page.locator('#view option:checked').textContent()).startsWith(text));
    await showView(page, 'reviews'); await page.locator('#reviewRecord').selectOption(reviewIndex);
    assert.ok((await page.locator('#reviewRecord option:checked').textContent()).startsWith(text));
    assert.ok((await page.locator('#reviewTitle').textContent()).startsWith(text));
    assert.ok((await page.locator('#reviewTitle').getAttribute('title')).includes(explanation));
    await showView(page, 'execute'); await page.locator('[data-execute-kind="project"]').click();
    await page.locator('#executeList').selectOption('project:project');
    assert.ok((await page.locator('#executeList option:checked').textContent()).startsWith(text));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  };
  await checkViews('😞', 'No next actions');
  await context.setOffline(true);
  const saveEdit = async () => {
    await page.getByRole('button', { name: 'Save edit on device', exact: true }).click();
    await page.locator('#editor').waitFor({ state: 'hidden' });
  };
  await showView(page, 'work'); await page.locator('#view').selectOption('project:project');
  await page.getByRole('button', { name: 'Edit Book tickets', exact: true }).click();
  await page.locator('#edit [name="status"]').selectOption('next'); await saveEdit();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=9'), state = await store.transact('alice');
    return state.queue.length > 0 && store.projected(state)['item:task'].status === 'next';
  });
  await checkViews('😐', 'Has next actions');
  await showView(page, 'work'); await page.locator('#view').selectOption('project:project');
  await page.getByRole('button', { name: 'Complete Book tickets', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#view option:checked').textContent.includes('All tasks completed'));
  await checkViews('😞', 'All tasks completed; project is not completed');
  await showView(page, 'work'); await page.locator('#view').selectOption('project:project');
  assert.equal(await page.locator('#items article').count(), 0, 'completed task is hidden by the active filter');
  await page.getByRole('button', { name: 'Edit project: Trip', exact: true }).click();
  await page.locator('#edit [name="projectStatus"]').selectOption('completed'); await saveEdit();
  await checkViews('😊', 'Project and all tasks completed');
  await showView(page, 'work'); await page.locator('#view').selectOption('project:project');
  await page.getByRole('button', { name: 'Edit project: Trip', exact: true }).click();
  await page.locator('#edit [name="projectStatus"]').selectOption('active'); await saveEdit();
  await page.locator('#statusFilter').selectOption('@all');
  await page.getByRole('button', { name: 'Reopen Book tickets', exact: true }).click();
  await checkViews('😐', 'Has next actions');
  await showView(page, 'work'); await page.locator('#view').selectOption('project:project');
  await clickControl(page.getByRole('button', { name: 'Delete item: Book tickets', exact: true, includeHidden: true }));
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=9');
    return store.projected(await store.transact('alice'))['item:task'].deleted;
  });
  await checkViews('😭', 'No tasks');
  await page.setViewportSize({ width: 320, height: 844 });
  await showView(page, 'plan');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).draft.navigation?.plan.focus === 'project:project');
  const pending = await page.evaluate(async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).queue);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.ok((await page.locator('#planFocus option[value="project:project"]').textContent()).includes('😭 Trip — No tasks'));
  assert.deepEqual(await page.evaluate(async () => (await (await import('/inbox-store.js?v=9')).transact('alice')).queue), pending);
  assert.equal(documents.filter(doc => doc.kind === 'record' && ['project', 'item'].includes(doc.record.type)).length, 2, 'offline display does not create records');
});
