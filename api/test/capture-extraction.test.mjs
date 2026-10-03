import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';
import { clickControl, showView } from './navigation-helper.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { captureClock, capturedTime, validateExtraction, extractionMutations } from '../../html/capture-extraction.js';
import { fieldsFor } from '../api/v1/contract.mjs';
import { enqueue } from '../../html/inbox-store.js';

const clock = captureClock(new Date('2026-10-03T05:30:00.000Z'), 'America/Regina');
const source = 'Call Sam tomorrow at 3 pm about the quote. Buy milk, urgent, at the shop.';
const suggestion = (fields = {}) => ({ title: 'Call Sam', description: 'About the quote', listId: '', priority: '', context: '', area: '', dueDate: '2026-10-03', dueTime: '15:00', evidence: 'Call Sam tomorrow at 3 pm about the quote.', uncertainty: '', ...fields });
const output = (items = [suggestion()]) => JSON.stringify({ items, notes: 'Check the quote before calling.' });
const records = () => documents.filter(doc => doc.kind === 'record').map(doc => doc.record);
const local = page => page.evaluate(async () => (await import('/inbox-store.js')).transact('alice'));
const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');

test('capture clock fixes relative-date context and rejects skipped/repeated wall times', () => {
  assert.equal(clock.today, '2026-10-02');
  assert.equal(capturedTime('2026-10-03T15:00', clock.timeZone), '2026-10-03T21:00:00.000Z');
  assert.equal(capturedTime('2026-10-03T15:00', 'Asia/Kathmandu'), '2026-10-03T09:15:00.000Z');
  for (const value of ['2026-03-08T02:30', '2026-11-01T01:30', '2026-02-30T12:30', '2026-10-03T24:00']) assert.throws(() => capturedTime(value, 'America/New_York'));
});

test('untrusted extraction is bounded, grounded, and cannot introduce record commands', () => {
  const parsed = validateExtraction(output([suggestion({ listId: 'unknown', priority: 'high' })]), source, [], clock);
  assert.equal(parsed.items[0].listId, ''); assert.equal(parsed.items[0].priority, ''); assert.match(parsed.items[0].uncertainty, /Unknown destination/);
  const uncertain = validateExtraction(output([suggestion({ dueDate: '2026-02-30' })]), source, [], clock);
  assert.equal(uncertain.items[0].dueDate, ''); assert.equal(uncertain.items[0].dueTime, '');
  for (const raw of ['null', '[]', '{}', 'not JSON', output([suggestion({ accountId: 'bob' })]), output([suggestion({ title: 'x'.repeat(201) })]), output([suggestion({ evidence: 'invented source' })]), output(Array.from({ length: 21 }, () => suggestion())), 'x'.repeat(65537)]) assert.throws(() => validateExtraction(raw, source, [], clock));
  assert.equal(validateExtraction(output([]), source, [], clock).items.length, 0);
  const single = 'Prepare report\nwith sales, costs, and footnotes.';
  assert.equal(validateExtraction(output([suggestion({ evidence: single, dueDate: '', dueTime: '' })]), single, [], clock).items.length, 1);
});

test('reviewed batches preserve original/identity, date-only semantics and trust-boundary limits', () => {
  const draft = { id: 'capture-one', source, clock, ...validateExtraction(output([suggestion({ dueTime: '' })]), source, [], clock) };
  const mutation = extractionMutations(draft, {})[0];
  assert.equal(mutation.fields.dueDate, '2026-10-03'); assert.equal(mutation.fields.dueDateUtc, null);
  assert.equal(mutation.fields.originalText, source); assert.equal(mutation.fields.captureId, draft.id);
  assert.equal(mutation.id, extractionMutations(draft, {})[0].id);
  assert.equal(fieldsFor('item', 'create', mutation.fields).captureTimeZone, 'America/Regina');
  assert.throws(() => fieldsFor('item', 'update', { captureId: 'replacement' }));
  for (const fields of [{ capturedAt: '' }, { capturedAt: '2026-02-30T00:00:00Z' }, { captureTimeZone: 'made-up' }, { captureId: '../bob' }]) assert.throws(() => fieldsFor('item', 'create', { ...mutation.fields, ...fields }));
  draft.items[0].listId = 'deleted'; assert.throws(() => extractionMutations(draft, { 'list:deleted': { deleted: true } }));
  draft.items[0].listId = ''; draft.source = 'x'.repeat(16000); draft.items = Array.from({ length: 5 }, () => ({ ...draft.items[0], id: crypto.randomUUID() }));
  const state = { records: {}, queue: [] }; assert.throws(() => enqueue(state, 'alice', extractionMutations(draft, {})), /too large/); assert.equal(state.queue.length, 0);
});

async function setup(t, mode = {}) {
  documents.length = 0; faults.loseBatchResponse = false; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Regina' });
  await context.addInitScript(({ mode, raw }) => {
    window.aiMode = mode; window.aiCalls = { prompts: [], creates: 0, destroyed: 0 };
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: mode.absent ? undefined : {
      availability: async () => mode.state || 'available',
      create: options => {
        aiCalls.creates++; aiCalls.active = navigator.userActivation.isActive;
        const model = { destroy() { aiCalls.destroyed++; }, prompt: async (text, options) => {
          aiCalls.prompts.push({ text, schema: options.responseConstraint });
          if (aiMode.fail) throw Error('Model failed');
          if (aiMode.delay) return new Promise(resolve => { window.finishAI = resolve; });
          return aiMode.raw || raw;
        } };
        return Promise.resolve(model);
      }
    } });
  }, { mode, raw: output([suggestion(), suggestion({ title: 'Buy milk', evidence: 'Buy milk, urgent, at the shop.', description: 'At the shop', priority: 'urgent', dueDate: '', dueTime: '' })]) });
  const page = await context.newPage();
  page.on('pageerror', error => assert.fail(error.message));
  await page.goto(server.url); await page.locator('#workspace').waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await page.locator('#captureAI summary').click();
  return { page, context, browser, server, setUser: value => { user = value; } };
}

test('opted-in automatic capture journals before inference, preserves corrections offline and accepts once', { timeout: 90000 }, async t => {
  const { page, context, browser } = await setup(t);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('#extractAuto').check();
  await page.locator('#captureText').fill(source);
  await page.locator('#extractReview').waitFor();
  assert.equal(await page.locator('#extractionReview').evaluate(el => el.open), false, 'automatic suggestions must not steal focus');
  assert.equal(await page.locator('#captureText').evaluate(el => document.activeElement === el), true);
  assert.equal(records().length, 0);
  assert.equal((await local(page)).draft.extraction.draft.source, source);
  const call = await page.evaluate(() => aiCalls.prompts[0]); assert.match(call.text, /America\/Regina/);
  await page.locator('#extractReview').click();
  await page.locator('#extractionItems [name=title]').first().fill('Call Sam about the revised quote');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.extraction.draft.items[0].title === 'Call Sam about the revised quote');
  if (process.env.EXTRACTION_SCREENSHOTS) {
    await mkdir(process.env.EXTRACTION_SCREENSHOTS, { recursive: true });
    for (const theme of ['dark', 'light']) for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('#extractionReview').evaluate(dialog => { dialog.scrollTop = 0; window.scrollTo(0, 0); });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bounds = await page.locator('#extractionReview').boundingBox();
      assert.ok(Math.abs(bounds.y + bounds.height - 900) < 2, 'review stays within the viewport');
      await page.screenshot({ path: `${process.env.EXTRACTION_SCREENSHOTS}/capture-${theme}-${width}.png` });
      assert.equal(await page.locator('#extractionReview').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    }
    console.log('Capture review screenshots: Chromium', browser.version());
  }
  await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor();
  await clickControl(page.locator('#extractReview')); await page.locator('#extractionItems [name=title]').first().waitFor();
  assert.equal(await page.locator('#extractionItems [name=title]').first().inputValue(), 'Call Sam about the revised quote');
  assert.equal(await page.evaluate(() => aiCalls.creates), 0, 'reload does not reprocess a saved review');
  const savedDraft = (await local(page)).draft;
  await page.locator('#extractAccept').click(); await page.locator('#extractionReview').waitFor({ state: 'hidden' });
  let saved = await local(page); assert.equal(saved.queue.length, 1); assert.equal(saved.queue[0].operation.mutations.length, 2);
  assert.equal(await page.locator('#captureText').inputValue(), '');
  faults.loseBatchResponse = true; await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(records().filter(record => record.type === 'item').length, 2);
  const task = records().find(record => record.title === 'Call Sam about the revised quote');
  assert.equal(task.originalText, source); assert.equal(task.captureId, savedDraft.extraction.draft.id);
  assert.equal(task.dueDateUtc, '2026-10-03T21:00:00.000Z');
  // Simulate a stale tab restoring a pre-acceptance draft after acknowledgement.
  await page.evaluate(async draft => (await import('/inbox-store.js')).transact('alice', state => { state.draft = draft; }), savedDraft);
  await page.reload(); await page.locator('#workspace').waitFor(); await clickControl(page.locator('#extractReview')); await page.locator('#extractAccept').click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('already accepted'));
  assert.equal(records().filter(record => record.type === 'item').length, 2); assert.deepEqual(errors, []);
});

test('manual capture survives absent or invalid local AI, and no tasks are saved implicitly', { timeout: 90000 }, async t => {
  const { page } = await setup(t, { absent: true });
  await page.locator('#captureText').fill('Milk'); await page.locator('#extractAuto').check();
  await page.waitForFunction(() => document.querySelector('#extractionStatus').textContent.includes('unavailable'));
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await confirmed(page);
  assert.equal(records().find(record => record.type === 'item').title, 'Milk');
});

test('late results cannot overwrite changed input, cancellation, or another account', { timeout: 90000 }, async t => {
  const { page, setUser } = await setup(t, { delay: true });
  await page.locator('#captureText').fill(source); await page.locator('#extractStart').click();
  await page.waitForFunction(() => !!window.finishAI);
  await page.locator('#captureText').fill('Newer input'); await page.evaluate(raw => finishAI(raw), output());
  assert.equal(await page.locator('#captureText').inputValue(), 'Newer input'); assert.equal(await page.locator('#extractReview').isHidden(), true);
  await page.locator('#captureText').fill(source); await page.locator('#extractStart').click();
  await page.waitForFunction(() => aiCalls.prompts.length === 2); await page.locator('#extractCancel').click();
  await page.evaluate(raw => finishAI(raw), output()); assert.equal(await page.locator('#extractReview').isHidden(), true);
  await page.locator('#extractStart').click(); await page.waitForFunction(() => aiCalls.prompts.length === 3);
  setUser('bob'); await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).accountId === 'bob');
  await page.evaluate(raw => finishAI(raw), output()); assert.equal(await page.locator('#extractReview').isHidden(), true);
  assert.equal(await page.locator('#captureText').inputValue(), ''); assert.equal(records().length, 0);
  assert.equal((await local(page)).draft.capture.text, source);
});

test('invalid output and no-action notes stay recoverable; add/remove edits are durable', { timeout: 90000 }, async t => {
  const { page } = await setup(t, { raw: output([suggestion({ accountId: 'bob' })]) });
  await page.locator('#captureText').fill(source); await page.locator('#extractStart').click();
  await page.waitForFunction(() => document.querySelector('#extractionStatus').textContent.includes('Unsupported'));
  assert.equal(await page.locator('#captureText').inputValue(), source); assert.equal(records().length, 0);
  await page.evaluate(raw => { aiMode.raw = raw; }, output([])); await page.locator('#extractStart').click();
  await page.locator('#extractionReview').waitFor(); assert.equal(await page.locator('#extractAccept').isDisabled(), true);
  await page.locator('#extractAdd').click(); await page.locator('#extractionItems [name=title]').fill('My manual task');
  await page.locator('#extractionItems [name=description]').fill('Keep these notes');
  await page.locator('#extractAdd').click(); await page.getByRole('button', { name: 'Remove task 2', exact: true }).click();
  await page.locator('#extractClose').click(); await page.locator('#extractStart').click();
  await page.waitForFunction(() => document.querySelector('#extractionStatus').textContent.includes('already saved'));
  assert.equal(await page.evaluate(() => aiCalls.creates), 2);
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('explicitly discard'));
  assert.equal(records().length, 0);
  await clickControl(page.locator('#extractReview')); assert.equal(await page.locator('#extractionItems [name=title]').inputValue(), 'My manual task');
});

test('model download requires interaction; explicit notes survive suggestions and later edits block acceptance', { timeout: 60000 }, async t => {
  const { page } = await setup(t, { state: 'downloadable' });
  await page.locator('#captureText').fill(source);
  await page.locator('#captureOptions > summary').click();
  await page.locator('#capture [name=body]').fill('Keep this exact note.');
  await page.locator('#extractStart').click(); await page.locator('#extractionReview').waitFor();
  assert.equal(await page.evaluate(() => aiCalls.active), true);
  assert.match(await page.locator('#extractionItems [name=description]').first().inputValue(), /Keep this exact note\./);
  await page.locator('#extractClose').click();
  await page.locator('#capture [name=body]').fill('A newer note');
  await clickControl(page.locator('#extractReview')); await page.locator('#extractAccept').click();
  await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Capture changed'));
  assert.equal(records().length, 0);
  assert.equal((await local(page)).draft.capture.body, 'A newer note');
});

test('failed persistence never passes capture to inference or loses its recovery text', { timeout: 60000 }, async t => {
  const { page } = await setup(t);
  await page.locator('#captureText').fill(source);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture?.text?.startsWith('Call Sam'));
  await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await page.locator('#extractStart').click();
  await page.locator('#recovery').waitFor();
  await page.waitForFunction(() => !document.querySelector('#extractStart').disabled);
  assert.equal(await page.evaluate(() => aiCalls.prompts.length), 0);
  assert.match(await page.locator('#recoveryText').inputValue(), /Call Sam tomorrow/);
  assert.equal(records().length, 0);
});

test('explicit AI completion preserves navigation and a later capture control, with keyboard review on demand', { timeout: 30000 }, async t => {
  const { page } = await setup(t, { delay: true });
  await page.locator('#captureText').fill(source);
  await page.locator('#extractStart').click();
  await page.waitForFunction(() => !!window.finishAI);
  await showView(page, 'work');
  await page.evaluate(raw => finishAI(raw), output());
  await page.waitForFunction(() => document.querySelector('#extractionStatus').textContent.startsWith('Suggestions saved'));
  assert.equal(await page.locator('#extractionReview').evaluate(dialog => dialog.open), false);
  assert.equal(await page.locator('#itemsHeading').evaluate(el => el === document.activeElement), true);
  await showView(page, 'capture');
  await page.locator('#extractReview').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'extractionHeading');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'extractReview');
  await page.locator('#extractReview').click(); await page.locator('#extractOriginal').click();
  await page.locator('#extractionReview').waitFor({ state: 'hidden' });
  await page.locator('#extractStart').click();
  await page.waitForFunction(() => aiCalls.prompts.length === 2);
  await page.locator('#captureText').focus();
  await page.evaluate(raw => finishAI(raw), output());
  await page.waitForFunction(() => document.querySelector('#extractionStatus').textContent.startsWith('Suggestions saved'));
  assert.equal(await page.locator('#extractionReview').evaluate(dialog => dialog.open), false);
  assert.equal(await page.locator('#captureText').evaluate(el => el === document.activeElement), true);
});

test('explicit AI success and failure retain the initiating keyboard control', { timeout: 30000 }, async t => {
  const { page } = await setup(t, { fail: true });
  await page.locator('#captureText').fill(source);
  await page.locator('#extractStart').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#extractionStatus').textContent === 'Model failed');
  await page.waitForFunction(() => document.activeElement.id === 'extractStart');
  await page.evaluate(() => { aiMode.fail = false; });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'extractionHeading');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.id === 'extractStart');
});

test('manual batch review works without AI, retains offline corrections and accepts once', { timeout: 60000 }, async t => {
  const { page, context } = await setup(t, { absent: true });
  const paragraph = 'One long thought '.repeat(30);
  await page.locator('#captureText').fill(paragraph);
  await page.locator('#captureOptions > summary').click();
  await page.locator('#capture [name=body]').fill('Keep these original notes.');
  await context.setOffline(true);
  await page.locator('#extractManual').click();
  await page.locator('#extractionReview').waitFor();
  assert.match(await page.locator('#extractionHelp').textContent(), /No AI was used/);
  await page.locator('#extractionItems [name=title]').fill('My first task');
  assert.equal(await page.locator('#extractionItems [name=description]').inputValue(), 'Keep these original notes.');
  await page.locator('#extractAdd').click();
  await page.locator('#extractionItems [name=title]').last().fill('My second task');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.extraction.draft.items[1].title === 'My second task');
  const draft = (await local(page)).draft.extraction.draft;
  await page.reload(); await page.locator('#workspace').waitFor(); await clickControl(page.locator('#extractReview'));
  assert.equal(await page.locator('#extractionItems [name=title]').last().inputValue(), 'My second task');
  assert.equal((await local(page)).draft.extraction.draft.clock.capturedAt, draft.clock.capturedAt);
  assert.equal(await page.evaluate(() => aiCalls.creates), 0);
  await page.locator('#extractAccept').click(); await page.locator('#extractionReview').waitFor({ state: 'hidden' });
  const saved = await local(page);
  assert.equal(saved.queue.length, 1); assert.equal(saved.queue[0].operation.mutations.length, 2);
  assert.equal(saved.queue[0].operation.mutations[0].fields.originalText, paragraph);
  assert.equal(saved.queue[0].operation.mutations[0].fields.captureId, draft.id);
  faults.loseBatchResponse = true; await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(records().filter(record => record.type === 'item').length, 2);
});

test('list-name permission is opt-in, persists per account and cancellation stops stale inference', async t => {
  const { page, setUser } = await setup(t);
  await page.evaluate(async () => {
    await (await import('/inbox-store.js')).transact('alice', local => {
      local.records['list:private'] = { type: 'list', id: 'private', title: 'Private list name', version: 1, accountId: 'alice', deleted: false };
    });
    document.querySelector('#sync').click();
  });
  await page.waitForFunction(() => [...document.querySelector('#capture [name=listId]').options].some(option => option.value === 'private'));
  await page.locator('#captureText').fill(source); await page.locator('#extractStart').click(); await page.locator('#extractionReview').waitFor();
  assert.ok(!(await page.evaluate(() => aiCalls.prompts[0].text)).includes('Private list name'));
  await page.locator('#extractOriginal').click();
  await page.locator('#extractLists').check();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.extraction.includeLists);
  await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#extractLists').isChecked(), true);
  await clickControl(page.locator('#extractStart')); await page.locator('#extractionReview').waitFor();
  assert.match(await page.evaluate(() => aiCalls.prompts[0].text), /Private list name/);
  await page.locator('#extractOriginal').click();
  await page.evaluate(() => { aiMode.delay = true; });
  await clickControl(page.locator('#extractStart')); await page.waitForFunction(() => !!window.finishAI);
  await page.locator('#extractLists').uncheck(); await page.evaluate(raw => finishAI(raw), output());
  assert.equal(await page.locator('#extractReview').isHidden(), true);
  await page.locator('#extractLists').check();
  await page.locator('#captureText').fill('Ordinary manual save');
  await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#captureText').value === '');
  await confirmed(page); await page.reload(); await page.locator('#workspace').waitFor();
  assert.equal(await page.locator('#extractLists').isChecked(), true);
  setUser('bob'); await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact(null)).accountId === 'bob');
  assert.equal(await page.locator('#extractLists').isChecked(), false);
});

test('merge review tasks preserves notes and attributes, journals the result and refuses overflow', async t => {
  const { page, context } = await setup(t);
  await page.locator('#captureText').fill(source); await page.locator('#extractStart').click(); await page.locator('#extractionReview').waitFor();
  const second = page.locator('#extractionItems fieldset').last();
  await second.locator('[name=description]').fill('a'.repeat(4000));
  await page.getByRole('button', { name: 'Merge into previous task' }).click();
  assert.match(await page.locator('#extractionError').textContent(), /exceed/);
  assert.equal(await page.locator('#extractionItems fieldset').count(), 2);
  await second.locator('[name=description]').fill('Get oat milk');
  await page.getByRole('button', { name: 'Merge into previous task' }).click();
  assert.equal(await page.locator('#extractionItems fieldset').count(), 1);
  const notes = await page.locator('#extractionItems [name=description]').inputValue();
  assert.match(notes, /Buy milk/); assert.match(notes, /Get oat milk/); assert.match(notes, /Priority: urgent/);
  assert.equal(await page.locator('#extractionItems [name=description]').evaluate(el => document.activeElement === el), true);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.extraction.draft.items.length === 1);
  await context.setOffline(true); await page.reload(); await page.locator('#workspace').waitFor(); await clickControl(page.locator('#extractReview'));
  assert.equal(await page.locator('#extractionItems [name=description]').inputValue(), notes);
  assert.equal((await local(page)).queue.length, 0);
});

test('manual review storage failures retain source and corrections without queuing tasks', async t => {
  const { page } = await setup(t, { absent: true });
  await page.locator('#captureText').fill(source);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.capture.text.startsWith('Call Sam tomorrow'));
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new DOMException('Full', 'QuotaExceededError'); };
  });
  await page.locator('#extractManual').click(); await page.locator('#recovery').waitFor();
  assert.match(await page.locator('#recoveryText').inputValue(), /Call Sam tomorrow/);
  assert.equal((await local(page)).queue.length, 0);
  await page.evaluate(() => { IDBObjectStore.prototype.put = originalPut; });
  await page.locator('#extractManual').click(); await page.locator('#extractionReview').waitFor();
  await page.locator('#extractionItems [name=title]').fill('Keep this correction');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js')).transact('alice')).draft.extraction?.draft?.items[0].title === 'Keep this correction');
  await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await page.locator('#extractAccept').click();
  // Recovery is already visible from the first failure; wait for this save to fail.
  await page.locator('#extractionReview').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#extractionError').textContent(), /Full/);
  assert.match(await page.locator('#recoveryText').inputValue(), /Keep this correction/);
  assert.equal((await local(page)).queue.length, 0);
  assert.equal(await page.evaluate(() => aiCalls.creates), 0);
});
