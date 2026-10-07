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
  return { page, context };
}
const local = page => page.evaluate(async () => { const store = await import('/inbox-store.js?v=11'); const state = await store.transact('alice'); return { state, records: store.projected(state) }; });

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
    const store = await import('/inbox-store.js?v=11'), records = store.projected(await store.transact('alice'));
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
    const store = await import('/inbox-store.js?v=11'), records = store.projected(await store.transact('alice'));
    const template = Object.values(records).find(record => record.type === 'recurrenceTemplate'), occurrence = Object.values(records).find(record => record.recurrenceTemplateId);
    return template?.description === 'Use rainwater next time' && template.referenceLinks?.[0] === 'https://example.com/plants' && occurrence?.description === '' && occurrence.referenceLinks?.length === 0;
  });
  await context.setOffline(true);
  await row.getByRole('button', { name: 'Complete Water plants' }).click();
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=11'), state = await store.transact('alice'), records = store.projected(state), occurrence = Object.values(records).find(record => record.recurrenceTemplateId);
    return state.queue.length > 0 && occurrence?.occurrenceState === 'completed' && occurrence.status === 'completed';
  });
  await page.reload(); await page.locator('#workspace').waitFor(); await showView(page, 'lists');
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  await dialog.getByText('Occurrence history', { exact: true }).click();
  await dialog.getByText(/completed/).waitFor();
  const opener = dialog.getByRole('button', { name: 'Close' });
  await opener.click();
  await context.setOffline(false); await clickControl(page.getByRole('button', { name: 'Sync now', includeHidden: true }));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=11')).transact('alice')).queue.length === 0);
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  await dialog.getByRole('button', { name: 'Pause template' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=11'); return Object.values(store.projected(await store.transact('alice'))).some(record => record.type === 'recurrenceTemplate' && record.paused); });
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  await dialog.getByRole('button', { name: 'Resume template' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=11'); return Object.values(store.projected(await store.transact('alice'))).some(record => record.type === 'recurrenceTemplate' && !record.paused && !record.tombstoned); });
  await page.locator('#recurringTemplates').getByRole('button', { name: 'Open template and history' }).click();
  page.once('dialog', prompt => prompt.accept());
  await dialog.getByRole('button', { name: 'Delete template' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=11'); return Object.values(store.projected(await store.transact('alice'))).some(record => record.type === 'recurrenceTemplate' && record.tombstoned); });
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
