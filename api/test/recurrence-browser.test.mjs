import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { clickControl, showView } from './navigation-helper.mjs';

const channel = process.env.CI ? 'chromium' : undefined;
async function setup(t) {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel }); t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  return { page, context, url: server.url };
}
const local = page => page.evaluate(async () => { const store = await import('/inbox-store.js?v=12'); const state = await store.transact('alice'); return { state, records: store.projected(state) }; });

test('recurring template UI creates one offline-safe occurrence, exposes history and retains it after stop', { timeout: 60000 }, async t => {
  const { page, context } = await setup(t);
  await showView(page, 'lists');
  await page.getByRole('button', { name: 'New recurring template' }).click();
  const dialog = page.locator('#recurringEditor');
  await dialog.getByLabel('Title').fill('Water plants');
  await dialog.getByLabel('First date').fill('2020-01-31');
  await dialog.getByLabel('Time zone').fill('America/Regina');
  await dialog.getByLabel('Unit').selectOption('month');
  await dialog.getByRole('button', { name: 'Save template on device' }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=12'), records = store.projected(await store.transact('alice'));
    return Object.values(records).some(record => record.type === 'recurrenceTemplate' && record.title === 'Water plants' && record.openOccurrenceId) &&
      Object.values(records).filter(record => record.recurrenceTemplateId).length === 1;
  });
  await showView(page, 'work'); await page.locator('#view').selectOption('all');
  const row = page.locator('.task-row').filter({ hasText: 'Water plants' });
  await row.waitFor(); assert.match(await row.textContent(), /Repeats · intended \d{4}-\d{2}-\d{2}/);
  await row.getByRole('button', { name: 'Edit Water plants' }).click();
  const editor = page.locator('#editor');
  await editor.getByLabel('Notes').fill('Use rainwater next time');
  await editor.locator('.task-metadata > summary').click();
  await editor.getByLabel('Reference links (one HTTP(S) URL per line)').fill('https://example.com/plants');
  await editor.getByLabel('Future occurrences only').check();
  await editor.getByRole('button', { name: 'Save edit on device' }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=12'), records = store.projected(await store.transact('alice'));
    const template = Object.values(records).find(record => record.type === 'recurrenceTemplate'), occurrence = Object.values(records).find(record => record.recurrenceTemplateId);
    return template?.description === 'Use rainwater next time' && template.referenceLinks?.[0] === 'https://example.com/plants' && occurrence?.description === '' && occurrence.referenceLinks?.length === 0;
  });
  await context.setOffline(true);
  await row.getByRole('button', { name: 'Complete Water plants' }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=12'), state = await store.transact('alice'), records = store.projected(state), occurrence = Object.values(records).find(record => record.recurrenceTemplateId);
    return state.queue.length > 0 && occurrence?.occurrenceState === 'completed' && occurrence.status === 'completed';
  });
  await page.reload(); await page.locator('#workspace').waitFor(); await showView(page, 'lists');
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  await dialog.getByText('Occurrence history', { exact: true }).click();
  await dialog.getByText(/completed/).waitFor();
  const opener = dialog.getByRole('button', { name: 'Close' });
  await opener.click();
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', includeHidden: true }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=12')).transact('alice')).queue.length === 0);
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  await dialog.getByRole('button', { name: 'Pause template' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=12'); return Object.values(store.projected(await store.transact('alice'))).some(record => record.type === 'recurrenceTemplate' && record.paused); });
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  await dialog.getByRole('button', { name: 'Resume template' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=12'); return Object.values(store.projected(await store.transact('alice'))).some(record => record.type === 'recurrenceTemplate' && !record.paused && !record.tombstoned); });
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  page.once('dialog', prompt => prompt.accept());
  await dialog.getByRole('button', { name: 'Delete template' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=12'); return Object.values(store.projected(await store.transact('alice'))).some(record => record.type === 'recurrenceTemplate' && record.tombstoned); });
  assert.match(await page.locator('#recurringTemplates').textContent(), /Stopped/);
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  assert.equal(await dialog.getByRole('button', { name: 'Resume template' }).count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Template stopped' }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Save template on device' }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.reload(); await page.locator('#workspace').waitFor();
  const stopped = await local(page); assert.equal(Object.values(stopped.records).filter(record => record.recurrenceTemplateId).length, 1);
});

test('recurring template sheet remains keyboard reachable and does not overflow narrow screens', async t => {
  const { page } = await setup(t); await page.setViewportSize({ width: 320, height: 720 }); await showView(page, 'lists');
  const open = page.getByRole('button', { name: 'New recurring template' }); await open.focus(); await page.keyboard.press('Enter');
  await page.locator('#recurringEditor').waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('#recurringEditor').scrollWidth <= document.querySelector('#recurringEditor').clientWidth), true);
  await page.keyboard.press('Escape'); await page.locator('#recurringEditor').waitFor({ state: 'hidden' });
  assert.equal(await open.evaluate(element => document.activeElement === element), true);
});

test('successful sync materializes due work in an active workspace that is not selected', { timeout: 60000 }, async t => {
  const { page, url } = await setup(t);
  const operation = { apiVersion: 1, accountId: 'alice', operationId: 'seed-other-workspace', mutations: [
    { type: 'workspace', id: 'work', action: 'create', expectedVersion: 0, fields: { title: 'Work' } },
    { type: 'recurrenceTemplate', id: 'work-series', action: 'create', expectedVersion: 0, fields: {
      title: 'Work recurrence', description: '', workspaceId: 'work', collectionRefs: [], listId: null, projectId: null, status: 'inbox', contexts: [], areas: [], energy: null, timeRequired: null, priority: null, referenceLinks: [],
      rule: { mode: 'fixed', unit: 'day', interval: 1, anchorDate: '2020-01-01', timeZone: 'America/Regina' }, paused: false, tombstoned: false, nextOccurrenceNumber: 1, nextIntendedDate: '2020-01-01', openOccurrenceId: null, lastResolvedUtc: null
    } }
  ] };
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(operation) });
  assert.equal(response.status, 200, await response.text());
  await clickControl(page.getByRole('button', { name: 'Sync now', includeHidden: true }));
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=12'), records = store.projected(await store.transact('alice'));
    const template = records['recurrenceTemplate:work-series'];
    return template?.openOccurrenceId && records[`item:${template.openOccurrenceId}`]?.workspaceId === 'work';
  });
  assert.equal(await page.locator('#workspaceSelect').inputValue(), 'personal');
});

test('stopping a template lets its destination be deleted without erasing occurrence history', { timeout: 60000 }, async t => {
  const { page, url } = await setup(t);
  const destination = { type: 'list', id: 'recurring-list', action: 'create', expectedVersion: 0, fields: { title: 'Chores', workspaceId: 'personal' } };
  const template = {
    title: 'Water plants', description: '', workspaceId: 'personal', collectionRefs: [{ type: 'list', id: 'recurring-list' }], listId: 'recurring-list', projectId: null,
    status: 'inbox', contexts: [], areas: [], energy: null, timeRequired: null, priority: null, referenceLinks: [],
    rule: { mode: 'fixed', unit: 'day', interval: 1, anchorDate: '2020-01-01', timeZone: 'America/Regina' }, paused: false, tombstoned: false,
    nextOccurrenceNumber: 1, nextIntendedDate: '2020-01-01', openOccurrenceId: null, lastResolvedUtc: null
  };
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({
    apiVersion: 1, accountId: 'alice', operationId: 'seed-recurring-list', mutations: [destination, { type: 'recurrenceTemplate', id: 'list-series', action: 'create', expectedVersion: 0, fields: template }]
  }) });
  assert.equal(response.status, 200, await response.text());
  await clickControl(page.getByRole('button', { name: 'Sync now', includeHidden: true }));
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=12'), records = store.projected(await store.transact('alice'));
    return !!records['recurrenceTemplate:list-series']?.openOccurrenceId;
  });
  await showView(page, 'lists'); await page.locator('#view').selectOption('recurring-list');
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  page.once('dialog', prompt => prompt.accept());
  await page.locator('#recurringEditor').getByRole('button', { name: 'Delete template' }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=12'), records = store.projected(await store.transact('alice'));
    return records['recurrenceTemplate:list-series']?.tombstoned === true;
  });
  await page.locator('#lists').getByRole('button', { name: 'Delete list: Chores' }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=12'), records = store.projected(await store.transact('alice'));
    const series = records['recurrenceTemplate:list-series'], occurrence = series && records[`item:${series.openOccurrenceId}`];
    return records['list:recurring-list']?.deleted === true && series?.tombstoned === true && occurrence?.deleted === false;
  });
});
