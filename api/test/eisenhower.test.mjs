import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fieldsFor } from '../api/v1/contract.mjs';
import { defaultSettings } from '../api/shared/defaults.mjs';
import { effectivePriority, compareExecutionItems, taskFields } from '../../html/inbox-fields.js';
import { recurrenceSnapshot, materializeMutations } from '../../html/recurrence-model.js';
import { recurrenceSnapshot as serverSnapshot } from '../api/v1/recurrence-model.mjs';
import { deviceExport, readableExport, validateDeviceExport } from '../../html/inbox-export.js';
import { documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { openAccountTaskOption, showView, clickControl } from './navigation-helper.mjs';

test('all nine diagonals rank by urgency, with unchanged manual ordering', () => {
  const cells = [1, 0, -1].flatMap(importance => [1, 0, -1].map(urgency => ({ importance, urgency, title: `${importance}/${urgency}`, priority: 'P5' })));
  assert.deepEqual(cells.map(item => effectivePriority(item, true)), ['P1', 'P2', 'P3', 'P2', 'P3', 'P4', 'P3', 'P4', 'P5']);
  assert.deepEqual(cells.sort((a, b) => compareExecutionItems(a, b, true)).map(item => [item.importance, item.urgency]), [[1,1],[0,1],[1,0],[-1,1],[0,0],[1,-1],[-1,0],[0,-1],[-1,-1]]);
  assert.equal(effectivePriority({}, true), 'P3');
  assert.equal(effectivePriority({ priority: 'Custom', importance: 1, urgency: 1 }), 'Custom');
  assert.ok(compareExecutionItems({ priority: 'P1', importance: -1 }, { priority: 'P5', importance: 1 }) < 0);
  assert.deepEqual(taskFields({ importance: 1, urgency: 0 }).importance, 1);
});

test('optional axes and settings have strict contracts and preserve legacy writes', () => {
  for (const type of ['item', 'recurrenceTemplate']) for (const name of ['importance', 'urgency']) {
    for (const value of [-1, 0, 1]) assert.equal(fieldsFor(type, 'update', { [name]: value })[name], value);
    for (const value of [true, false, null, '1', 0.5, 2, -2]) assert.throws(() => fieldsFor(type, 'update', { [name]: value }), /-1, 0 or 1/);
  }
  assert.deepEqual(fieldsFor('settings', 'update', { eisenhowerPriority: true }), { eisenhowerPriority: true });
  assert.deepEqual(fieldsFor('settings', 'create', { eisenhowerPriority: true }), { defaults: defaultSettings, eisenhowerPriority: true });
  assert.deepEqual(fieldsFor('settings', 'update', { defaults: defaultSettings }), { defaults: defaultSettings });
  for (const value of [1, 'true', null]) assert.throws(() => fieldsFor('settings', 'update', { eisenhowerPriority: value }), /true or false/);
  assert.throws(() => fieldsFor('settings', 'update', {}), /edit/);
  const template = { id: 'repeat', version: 1, title: 'Repeat', workspaceId: 'personal', collectionRefs: [], status: 'next', priority: 'P5', importance: 1, urgency: -1,
    rule: { mode: 'fixed', unit: 'day', interval: 1, anchorDate: '2020-01-01', timeZone: 'America/Regina' }, nextOccurrenceNumber: 1, nextIntendedDate: '2020-01-01' };
  assert.deepEqual(recurrenceSnapshot(template), serverSnapshot(template));
  assert.equal(materializeMutations(template)[1].fields.urgency, -1);
  assert.equal('importance' in recurrenceSnapshot({ title: 'Legacy' }), false);
  const records = { 'item:task': { type: 'item', id: 'task', workspaceId: 'personal', collectionRefs: [], status: 'next', priority: 'P5', importance: 1, urgency: -1 }, 'settings:settings': { type: 'settings', id: 'settings', eisenhowerPriority: true } };
  for (const record of Object.values(records)) Object.assign(record, { accountId: 'alice', version: 1, deleted: false });
  const exported = deviceExport('alice', { records, queue: [], draft: {}, after: 0 }, {});
  assert.deepEqual(validateDeviceExport(exported).warnings, []);
  assert.match(readableExport(exported), /importance.*1/i); assert.match(readableExport(exported), /Eisenhower Priority.*true/i);
  exported.state.records['item:task'].urgency = '1'; assert.throws(() => validateDeviceExport(exported), /urgency/);
});

async function state(page) { return page.evaluate(async () => { const store = await import('/inbox-store.js?v=21'); const state = await store.transact('alice'); return { state, records: store.projected(state) }; }); }
async function matrixMode(page, enabled) {
  await openAccountTaskOption(page, 'priority'); await page.locator('#eisenhowerPriority').setChecked(enabled);
  await page.locator('#defaultsForm').getByRole('button', { name: 'Save' }).click();
  await waitForBrowser(page, async expected => { const store = await import('/inbox-store.js?v=21'), local = await store.transact('alice'); return store.projected(local)['settings:settings']?.eisenhowerPriority === expected && local.queue.length === 0; }, enabled);
}

test('account matrix controls preserve manual data, cross-tab drafts, offline reload, and recurring/capture review answers', { timeout: 90000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 320, height: 844 } }), page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await openAccountTaskOption(page, 'priority'); assert.equal(await page.locator('#eisenhowerPriority').isChecked(), false);
  await showView(page, 'capture'); await page.locator('#captureText').fill('Preserve priority'); await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await showView(page, 'work'); const row = page.locator('.task-row').filter({ hasText: 'Preserve priority' }); await row.getByRole('button', { name: 'Edit Preserve priority' }).click();
  const editor = page.locator('#editor'); await editor.locator('.task-metadata > summary').click();
  await editor.locator('select[name=priority]').selectOption('P5'); await editor.getByRole('button', { name: 'Save edit on device' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), s = await store.transact('alice'); return Object.values(store.projected(s)).some(x => x.type === 'item' && x.priority === 'P5') && s.queue.length === 0; });
  await matrixMode(page, true); await showView(page, 'work'); await row.getByRole('button', { name: 'Edit Preserve priority' }).click(); await editor.locator('.task-metadata > summary').click();
  assert.equal(await editor.locator('.matrix-priority input[type=radio]').count(), 6); assert.equal(await editor.locator('select[name=priority]').isVisible(), false);
  assert.equal(await editor.locator('output').textContent(), 'Priority P3');
  await editor.getByLabel('Important', { exact: true }).check(); await editor.getByLabel('Urgent', { exact: true }).check(); assert.equal(await editor.locator('output').textContent(), 'Priority P1');
  const targets = await editor.locator('.matrix-priority label').evaluateAll(labels => labels.map(label => label.getBoundingClientRect().height)); assert.ok(targets.every(height => height >= 44));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await editor.getByRole('button', { name: 'Save edit on device' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), s = await store.transact('alice'); return Object.values(store.projected(s)).some(x => x.type === 'item' && x.priority === 'P5' && x.importance === 1 && x.urgency === 1) && s.queue.length === 0; });
  await row.getByRole('button', { name: 'Edit Preserve priority' }).click(); await editor.getByLabel('Notes').fill('Unsaved across mode switches'); await editor.locator('.task-metadata > summary').click(); await editor.getByLabel('Not important', { exact: true }).check();
  const second = await context.newPage(); await second.goto(server.url); await second.locator('#workspace').waitFor(); await second.keyboard.press('Escape'); await second.locator('#editor').waitFor({ state: 'hidden' }); second.once('dialog', dialog => dialog.accept()); await second.locator('#discardEdit').click(); await second.locator('#savedEdit').waitFor({ state: 'hidden' }); await matrixMode(second, false);
  await editor.locator('select[name=priority]').waitFor(); assert.equal(await editor.getByLabel('Notes').inputValue(), 'Unsaved across mode switches'); assert.equal(await editor.locator('select[name=priority]').inputValue(), 'P5');
  await matrixMode(second, true); await editor.getByLabel('Not important', { exact: true }).waitFor(); assert.equal(await editor.getByLabel('Not important', { exact: true }).isChecked(), true);
  await editor.getByLabel('Unset', { exact: true }).first().focus(); await page.keyboard.press('ArrowRight'); assert.equal(await editor.getByLabel('Not important', { exact: true }).isChecked(), true);
  await editor.getByRole('button', { name: 'Save edit on device' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), s = await store.transact('alice'); return Object.values(store.projected(s)).some(x => x.title === 'Preserve priority' && x.importance === -1 && x.description === 'Unsaved across mode switches') && s.queue.length === 0; });
  await matrixMode(second, false); await row.getByRole('button', { name: 'Edit Preserve priority' }).click(); await editor.locator('.task-metadata > summary').click();
  assert.equal(await editor.locator('select[name=priority]').inputValue(), 'P5'); await editor.getByLabel('Notes').fill('Manual notes preserve matrix');
  await editor.getByRole('button', { name: 'Save edit on device' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), s = await store.transact('alice'); return Object.values(store.projected(s)).some(x => x.title === 'Preserve priority' && x.priority === 'P5' && x.importance === -1 && x.urgency === 1 && x.description === 'Manual notes preserve matrix') && s.queue.length === 0; });
  await matrixMode(second, true); await second.close();
  await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor(); await showView(page, 'work'); await row.getByRole('button', { name: 'Edit Preserve priority' }).click(); await editor.locator('.task-metadata > summary').click(); assert.equal(await editor.getByLabel('Not important', { exact: true }).isChecked(), true);
  await editor.getByLabel('Notes').fill('Offline matrix notes'); await editor.getByRole('button', { name: 'Save edit on device' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), s = await store.transact('alice'); return s.queue.some(x => x.operation.mutations.some(m => m.fields?.description === 'Offline matrix notes')); });
  await context.setOffline(false);
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), s = await store.transact('alice'); return s.queue.length === 0 && Object.values(s.records).some(x => x.title === 'Preserve priority' && x.description === 'Offline matrix notes'); });
  await showView(page, 'lists'); await clickControl(page.locator('#newRecurring')); const recurring = page.locator('#recurringEditor');
  await recurring.getByLabel('Title').fill('Matrix repeat'); await recurring.getByLabel('First date').fill('2020-01-01'); await recurring.getByLabel('Important', { exact: true }).check(); await recurring.getByLabel('Not urgent', { exact: true }).check(); await recurring.getByRole('button', { name: 'Save template on device' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), records = store.projected(await store.transact('alice')); return Object.values(records).some(x => x.recurrenceTemplateId && x.importance === 1 && x.urgency === -1); });
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=21')).transact('alice')).queue.length === 0);
  await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=21');
    await store.transact('alice', local => {
      const records = Object.values(store.projected(local)), template = records.find(x => x.type === 'recurrenceTemplate' && x.title === 'Matrix repeat'), occurrence = records.find(x => x.recurrenceTemplateId === template.id);
      store.enqueue(local, 'alice', [{ type: 'recurrenceTemplate', id: template.id, action: 'update', expectedVersion: template.version, fields: { priority: 'P5' } }, { type: 'item', id: occurrence.id, action: 'update', expectedVersion: occurrence.version, fields: { priority: 'P1' } }]);
    });
  });
  await page.reload(); await page.locator('#workspace').waitFor(); await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=21')).transact('alice')).queue.length === 0);
  await showView(page, 'work');
  const repeatingRow = page.locator('.task-row').filter({ hasText: 'Matrix repeat' });
  for (const [scope, importance, urgency, expectedTemplate, expectedOccurrence] of [
    ['This occurrence only', -1, -1, [1,-1], [-1,-1]],
    ['Future occurrences only', -1, 1, [-1,1], [-1,-1]],
    ['This and future occurrences', 0, 0, [0,0], [0,0]]
  ]) {
    await repeatingRow.getByRole('button', { name: 'Edit Matrix repeat' }).click(); await editor.locator('.task-metadata > summary').click();
    await editor.locator(`input[name=importance][value="${importance}"]`).check(); await editor.locator(`input[name=urgency][value="${urgency}"]`).check();
    await editor.getByLabel(scope, { exact: true }).check(); await editor.getByRole('button', { name: 'Save edit on device' }).click();
    await waitForBrowser(page, async expected => {
      const store = await import('/inbox-store.js?v=21'), s = await store.transact('alice'), records = Object.values(store.projected(s));
      const template = records.find(x => x.type === 'recurrenceTemplate' && x.title === 'Matrix repeat'), occurrence = records.find(x => x.recurrenceTemplateId === template?.id);
      return s.queue.length === 0 && template?.priority === 'P5' && occurrence?.priority === 'P1' && template?.importance === expected[0][0] && template?.urgency === expected[0][1] && occurrence?.importance === expected[1][0] && occurrence?.urgency === expected[1][1];
    }, [expectedTemplate, expectedOccurrence]);
  }
  await showView(page, 'capture');
  await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=21');
    await store.transact('alice', local => {
      const source = 'One matrix task, Second matrix task', inputCapture = { text: source, contexts: [], listId: '', newList: '' };
      const clock = { capturedAt: '2026-10-14T12:00:00.000Z', timeZone: 'America/Regina', today: '2026-10-14' };
      local.draft.capture = inputCapture;
      local.draft.extraction = { draft: { id: crypto.randomUUID(), manual: true, source, inputCapture, clock, notes: '', items: ['One matrix task', 'Second matrix task'].map((title, index) => ({ id: crypto.randomUUID(), title, description: '', listId: '', priority: index === 0 ? 'P5' : '', context: '', dueDate: '', dueTime: '', evidence: title, uncertainty: '' })) }, clock, sourceText: source, enabled: false, includeLists: false };
    });
  });
  await page.reload(); await page.locator('#workspace').waitFor(); await page.locator('#extractReview').click(); const review = page.locator('#extractionReview'); await review.getByLabel('Important', { exact: true }).first().check(); await review.getByLabel('Urgent', { exact: true }).first().check();
  await review.getByLabel('Not important', { exact: true }).last().check(); await review.getByLabel('Not urgent', { exact: true }).last().check();
  await review.getByRole('button', { name: 'Merge into previous task' }).click(); assert.match(await review.locator('[name=description]').inputValue(), /Importance: -1/); assert.match(await review.locator('[name=description]').inputValue(), /Urgency: -1/);
  await page.locator('#extractAccept').click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), records = store.projected(await store.transact('alice')); return Object.values(records).some(x => x.title === 'One matrix task' && x.priority === 'P5' && x.importance === 1 && x.urgency === 1); });
  const final = await state(page); assert.equal(Object.values(final.records).find(x => x.title === 'Preserve priority').priority, 'P5');
});

test('device-only preference and matrix drafts stay local; queue rejects malformed matrix fields', { timeout: 45000 }, async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await openAccountTaskOption(page, 'priority');
  assert.equal(await page.locator('#eisenhowerPriority').isChecked(), false); await page.locator('#eisenhowerPriority').check();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=21')).transact('device-local')).preferenceDraft?.defaults?.eisenhowerPriority === true);
  await page.reload(); await page.locator('#workspace').waitFor(); assert.equal(await page.locator('#eisenhowerPriority').isChecked(), true);
  await page.locator('#defaultsForm').getByRole('button', { name: 'Save' }).click();
  await waitForBrowser(page, async () => { const store = await import('/inbox-store.js?v=21'), state = await store.transact('device-local'); return store.projected(state)['settings:settings']?.eisenhowerPriority === true && state.queue.some(entry => entry.operation.mutations.some(m => m.type === 'settings' && m.fields.eisenhowerPriority === true)); });
  const rejected = await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=21');
    return [true, null, '1', .5, 2, -2].map(value => {
      const local = { records: {}, queue: [], after: 0, draft: {} };
      try { store.enqueue(local, 'device-local', [{ type: 'item', id: 'bad', action: 'create', expectedVersion: 0, fields: { title: 'Bad', workspaceId: 'personal', collectionRefs: [], status: 'inbox', importance: value } }]); return false; }
      catch { return local.queue.length === 0; }
    });
  }); assert.ok(rejected.every(Boolean));
  assert.equal(documents.filter(doc => doc.kind === 'record').length, 0);
});
