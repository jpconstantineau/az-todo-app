import { clickControl } from './navigation-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, faults, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { decision, emptyProposal } from '../../html/clarification.js';
import { clarificationFields } from '../api/v1/clarification.mjs';
import { deviceExport, readableExport, validateDeviceExport } from '../../html/inbox-export.js';

const initial = () => ({ step: 0, answers: {}, proposal: emptyProposal() });
const mutation = (type, version, fields, action = version ? 'update' : 'create') => ({ type, id: 'insurance', expectedVersion: version, action, ...(fields ? { fields } : {}) });
const record = type => documents.find(doc => doc.UserID === 'alice' && doc.id === `record:${type}:insurance`)?.record;
async function post(url, mutations, operationId = crypto.randomUUID(), user = 'alice') {
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json',
    'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: user, userRoles: ['authenticated'] })).toString('base64') },
    body: JSON.stringify({ apiVersion: 1, accountId: user, operationId, mutations }) });
  return { status: response.status, body: await response.json() };
}

test('clarification API validates separate proposals, ownership, atomic decisions, repeat delivery and stale/deleted actions', async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  const save = (mutations, id, user) => post(server.url, mutations, id, user);
  assert.equal((await save([mutation('clarification', 0, initial())])).status, 404);
  assert.equal((await save([mutation('item', 0, { title: 'sort out insurance', originalText: 'sort out insurance' })])).status, 200);
  assert.equal((await save([mutation('clarification', 0, initial())], undefined, 'bob')).status, 404);
  const session = { ...initial(), proposal: { ...emptyProposal(), text: 'Unaccepted outcome' } };
  assert.equal((await save([mutation('clarification', 0, session)])).status, 200);
  assert.equal(record('item').version, 1);
  const outcome = decision(session, { ...emptyProposal(), text: 'Coverage in place' }, 'accepted').session;
  assert.equal((await save([mutation('clarification', 1, outcome)])).status, 200);
  const action = decision(outcome, { ...emptyProposal(), text: 'Call the insurer' }, 'accepted');
  const accepted = [mutation('clarification', 2, action.session), mutation('item', 1, action.fields)];
  faults.batchIndex = 2;
  assert.equal((await save(accepted)).status, 503);
  assert.equal(record('clarification').step, 1); assert.equal(record('item').title, 'sort out insurance');
  faults.loseBatchResponse = true;
  assert.equal((await save(accepted, 'lost-acceptance')).status, 503);
  const retry = await save(accepted, 'lost-acceptance');
  assert.equal(retry.status, 200); assert.deepEqual(await save(accepted, 'lost-acceptance'), retry);
  assert.equal(record('clarification').version, 3); assert.equal(record('item').version, 2);
  assert.equal(record('item').originalText, 'sort out insurance');
  assert.equal((await save([mutation('clarification', 2, action.session), mutation('item', 2, { title: 'Stale proposal' })])).status, 409);
  assert.equal(record('item').title, 'Call the insurer');
  assert.equal((await save([mutation('item', 2, undefined, 'delete')])).status, 200);
  assert.equal((await save([mutation('clarification', 3, action.session)])).status, 404);
  assert.equal((await save([mutation('clarification', 3, action.session), mutation('item', 2, { title: 'Resurrect' })])).status, 409);
  assert.equal(record('item').deleted, true);
});

test('waiting clarification accepts no new date and preserves existing calendar or timed cues', async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  for (const [id, cue] of Object.entries({ undated: {}, calendar: { reviewDate: '2026-10-05' }, timed: { reviewDateUtc: '2026-10-05T18:00:00.000Z' } })) {
    let session = initial();
    for (let step = 0; step < 3; step++) session = decision(session, emptyProposal(), 'skipped').session;
    const created = await post(server.url, [{ ...mutation('item', 0, { title: 'Get approval', ...cue }), id }]);
    assert.equal(created.status, 200);
    const accepted = decision(session, { ...emptyProposal(), status: 'waiting', waitingOn: 'Alex' }, 'accepted');
    const saved = await post(server.url, [{ ...mutation('clarification', 0, accepted.session), id }, { ...mutation('item', 1, accepted.fields), id }]);
    assert.equal(saved.status, 200);
    const item = saved.body.records.find(record => record.type === 'item');
    assert.equal(item.status, 'waiting'); assert.equal(item.waitingOn, 'Alex');
    assert.equal(item.reviewDate ?? null, cue.reviewDate || null); assert.equal(item.reviewDateUtc, cue.reviewDateUtc || null);
  }
});

test('clarification rules keep unknowns explicit and reject invented facts or invalid state', () => {
  const skipped = decision(initial(), emptyProposal(), 'skipped');
  assert.deepEqual(skipped.session.answers.outcome, { decision: 'skipped', value: null });
  assert.equal(skipped.fields, null);
  assert.deepEqual(clarificationFields(skipped.session), skipped.session);
  assert.throws(() => decision(initial(), emptyProposal(), 'accepted'), /Enter an answer/);
  assert.throws(() => clarificationFields({ ...initial(), answers: { outcome: { decision: 'accepted', value: 'Invented' } } }), /Future/);
  assert.throws(() => clarificationFields({ ...initial(), step: 1 }), /Invalid/);
  assert.throws(() => clarificationFields({ ...skipped.session, answers: { outcome: { decision: 'skipped', value: 'Invented' } } }), /unknown/);
  assert.throws(() => clarificationFields({ ...initial(), proposal: { ...emptyProposal(), reviewDate: '2026-02-30' } }), /calendar date/);
  assert.throws(() => clarificationFields({ ...initial(), originalText: 'Overwrite capture' }), /Invalid/);
  let session = skipped.session;
  session = decision(session, emptyProposal(), 'skipped').session;
  session = decision(session, { ...emptyProposal(), text: 'None known' }, 'accepted').session;
  assert.equal(session.answers.missingFacts.value, 'None known');
  assert.throws(() => decision(session, { ...emptyProposal(), status: 'waiting' }, 'accepted'), /Waiting needs/);
  const waiting = decision(session, { ...emptyProposal(), status: 'waiting', waitingOn: 'Broker' }, 'accepted');
  assert.deepEqual(waiting.fields, { status: 'waiting', waitingOn: 'Broker' }, 'omitting a review date preserves any existing cue');
  assert.equal(clarificationFields(waiting.session).answers.disposition.value.reviewDate, '');
  assert.throws(() => clarificationFields({ ...waiting.session, answers: { ...waiting.session.answers,
    disposition: { decision: 'accepted', value: { ...waiting.session.answers.disposition.value, waitingOn: '   ' } } } }), /Waiting needs/);
  const dated = decision(session, { ...emptyProposal(), status: 'waiting', waitingOn: 'Broker', reviewDate: '2026-10-05' }, 'accepted');
  assert.deepEqual(dated.fields, { status: 'waiting', waitingOn: 'Broker', reviewDate: '2026-10-05', reviewDateUtc: null });
  assert.equal(clarificationFields(dated.session).step, 4);
  assert.throws(() => decision(session, { ...emptyProposal(), status: 'deferred' }, 'accepted'), /Deferred needs/);
  const deferred = decision(session, { ...emptyProposal(), status: 'deferred', startDate: '2026-10-05' }, 'accepted');
  assert.deepEqual(deferred.fields, { status: 'deferred', startDate: '2026-10-05', startDateUtc: null });
  assert.equal(clarificationFields(deferred.session).step, 4);
});

const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=1')).transact('alice'));
async function browserSetup(t) {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  await post(server.url, [mutation('item', 0, { title: 'sort out insurance' })]);
  // Already-started v1 sessions must continue unchanged after upgrading the shell.
  await post(server.url, [mutation('clarification', 0, initial())]);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => { Object.defineProperty(globalThis, 'LanguageModel', { value: undefined, configurable: true }); });
  const page = await context.newPage();
  await page.goto(server.url + '/#work'); await page.locator('#workspace').waitFor(); await page.locator('#view').selectOption('all'); await page.getByRole('button', { name: 'Edit sort out insurance', exact: true }).waitFor(); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  return { page, context, browser, url: server.url, setUser: value => { user = value; } };
}
const question = (page, step) => page.waitForFunction(step => document.querySelector('#clarifyHeading').textContent === (step === 4 ? 'Clarification complete' : `Question ${step + 1} of 4`), step);

test('direct clarification skips only unanswered questions and accepts simple dispositions through the API', async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  const outcome = decision(initial(), { ...emptyProposal(), text: 'An optional outcome' }, 'accepted').session;
  const direct = decision(outcome, emptyProposal(), 'disposition');
  assert.equal(direct.fields, null);
  assert.equal(direct.session.step, 3);
  assert.deepEqual(direct.session.answers.outcome, outcome.answers.outcome);
  assert.deepEqual(direct.session.answers.nextAction, { decision: 'skipped', value: null });
  assert.deepEqual(clarificationFields(direct.session), direct.session);
  assert.throws(() => decision(initial(), { ...emptyProposal(), text: 'Keep my draft' }, 'disposition'), /wording is still here/);
  for (const status of ['next', 'someday', 'reference', 'completed', 'dropped']) {
    const id = `direct-${status}`;
    assert.equal((await post(server.url, [{ ...mutation('item', 0, { title: id, originalText: 'Original capture' }), id }])).status, 200);
    const result = decision(decision(initial(), emptyProposal(), 'disposition').session, { ...emptyProposal(), status }, 'accepted');
    const mutations = [{ ...mutation('clarification', 0, result.session), id }, { ...mutation('item', 1, result.fields), id }];
    const saved = await post(server.url, mutations, id);
    assert.equal(saved.status, 200);
    assert.deepEqual(await post(server.url, mutations, id), saved);
    const item = saved.body.records.find(record => record.type === 'item');
    assert.equal(item.status, status); assert.equal(item.title, id); assert.equal(item.originalText, 'Original capture');
  }
});

test('direct clarification works offline, preserves wording, resumes and closes with Done', { timeout: 60000 }, async t => {
  const { page, context } = await browserSetup(t);
  await context.setOffline(true);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  assert.equal(await page.locator('#clarifyStop').textContent(), 'Stop for now');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.locator('#clarifier').evaluate(el => el.scrollWidth <= el.clientWidth));
    if (process.env.CLARIFICATION_SCREENSHOTS) {
      await mkdir(process.env.CLARIFICATION_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.CLARIFICATION_SCREENSHOTS}/direct-clarification-${width}.png` });
    }
  }
  await page.locator('#clarifyForm [name=text]').fill('Keep my optional outcome');
  await page.locator('#clarifyDirect').click(); await page.locator('#clarifyError').waitFor();
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Keep my optional outcome');
  assert.equal((await local(page)).queue.length, 0);
  await page.locator('#clarifyAccept').click(); await question(page, 1);
  await page.locator('#clarifyDirect').focus(); await page.keyboard.press('Enter'); await question(page, 3);
  assert.equal(await page.locator('#clarifyQuestion').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#clarifyDirect').isVisible(), false);
  await page.reload(); await page.locator('#clarifier').waitFor(); await question(page, 3);
  await page.locator('#clarifyForm [name=status]').selectOption('someday');
  await page.locator('#clarifyAccept').click(); await question(page, 4);
  assert.equal(await page.locator('#clarifyStop').textContent(), 'Done');
  assert.match(await page.locator('#clarifyAnswers').textContent(), /Keep my optional outcome/);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.locator('#clarifier').evaluate(el => el.scrollWidth <= el.clientWidth));
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(record('item').status, 'someday');
  assert.equal(record('item').originalText, 'sort out insurance');
  assert.equal(record('clarification').answers.outcome.value, 'Keep my optional outcome');
  assert.equal(record('clarification').answers.nextAction.decision, 'skipped');
});

test('completed legacy reference can restart its original questionnaire offline and save new answers', { timeout: 60000 }, async t => {
  const { page, context } = await browserSetup(t);
  await clickControl(page.getByRole('button', { name: 'Clarify sort out insurance', exact: true, includeHidden: true }));
  assert.equal(await page.locator('#clarifyRestart').isVisible(), false);
  await page.locator('#clarifyDirect').click(); await question(page, 3);
  await page.locator('#clarifyForm [name=status]').selectOption('reference');
  await page.locator('#clarifyAccept').click(); await question(page, 4); await confirmed(page);
  const before = structuredClone(record('item')), version = record('clarification').version;
  await page.locator('#clarifyStop').click(); await page.locator('#statusFilter').selectOption('reference');
  await clickControl(page.getByRole('button', { name: 'Clarify sort out insurance', exact: true, includeHidden: true }));
  await question(page, 4); await context.setOffline(true); await page.locator('#clarifyRestart').click(); await question(page, 0);
  const pending = await local(page);
  assert.equal(pending.queue.length, 1); assert.equal(pending.queue[0].operation.mutations.length, 1);
  assert.equal(pending.queue[0].operation.mutations[0].expectedVersion, version);
  assert.deepEqual(pending.queue[0].operation.mutations[0].fields, initial());
  assert.deepEqual(record('item'), before);
  await page.reload(); await page.locator('#clarifier').waitFor(); await question(page, 0);
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), '');
  assert.equal(await page.locator('#clarifyRestart').isVisible(), false);
  await page.locator('#clarifyForm [name=text]').fill('Coverage renewed');
  await page.locator('#clarifyAccept').click(); await question(page, 1);
  await page.locator('#clarifyForm [name=text]').fill('Call for renewal');
  await page.locator('#clarifyAccept').click(); await question(page, 2);
  await page.locator('#clarifySkip').click(); await question(page, 3);
  await page.locator('#clarifyForm [name=status]').selectOption('next');
  await page.locator('#clarifyAccept').click(); await question(page, 4); await page.locator('#clarifyStop').click();
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(record('item').title, 'Call for renewal'); assert.equal(record('item').status, 'next');
  assert.equal(record('item').originalText, 'sort out insurance');
  assert.equal(record('clarification').flowVersion, undefined); assert.equal(record('clarification').answers.outcome.value, 'Coverage renewed');
});

test('clarification browser: no AI, offline stop/reload/resume, editable proposals, explicit acceptance and original retention', { timeout: 60000 }, async t => {
  const { page, context, browser, url } = await browserSetup(t);
  assert.equal(await page.evaluate(() => typeof LanguageModel), 'undefined');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await context.setOffline(true);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  await page.locator('#clarifyForm [name=text]').fill('Coverage in place');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=1')).transact('alice')).draft.clarification?.proposal.text === 'Coverage in place');
  await page.locator('#clarifyStop').click(); await page.locator('#clarifier').waitFor({ state: 'hidden' });
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=1')).transact('alice')).draft.clarification?.open === false);
  await page.reload(); await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Coverage in place');
  assert.equal((await local(page)).queue.length, 0);
  await page.locator('#clarifyAccept').click(); await question(page, 1);
  await page.locator('#clarifyForm [name=text]').fill('Call someone');
  await page.locator('#clarifySave').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=1')).transact('alice')).queue.length === 2);
  assert.equal((await local(page)).records['item:insurance'].title, 'sort out insurance');
  await page.locator('#clarifyForm [name=text]').fill('Call the insurer');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=1')).transact('alice')).draft.clarification?.proposal.text === 'Call the insurer');
  await page.reload(); await page.locator('#clarifier').waitFor(); await question(page, 1);
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Call the insurer');
  if (process.env.CLARIFICATION_SCREENSHOTS) {
    await mkdir(process.env.CLARIFICATION_SCREENSHOTS, { recursive: true });
    console.log('Clarification evidence browser:', browser.version());
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${process.env.CLARIFICATION_SCREENSHOTS}/clarification-${width}.png` });
    }
  }
  await page.locator('#clarifyAccept').click(); await question(page, 2);
  await page.locator('#clarifySkip').click(); await question(page, 3);
  await page.locator('#clarifyForm [name=status]').selectOption('waiting');
  await page.locator('#clarifyAccept').click(); await page.locator('#clarifyError').waitFor();
  assert.match(await page.locator('#clarifyError').textContent(), /Waiting needs/);
  await page.locator('#clarifyForm [name=waitingOn]').fill('Broker');
  await page.locator('#clarifyAccept').click(); await question(page, 4);
  assert.match(await page.locator('#clarifyAnswers').textContent(), /Unknown — skipped/);
  assert.equal(await page.locator('#clarifyOriginal').textContent(), 'sort out insurance');
  await page.locator('#clarifyStop').click();
  await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  assert.equal(record('item').title, 'Call the insurer'); assert.equal(record('item').status, 'waiting');
  assert.equal(record('item').originalText, 'sort out insurance'); assert.equal(record('item').waitingOn, 'Broker');
  assert.equal(record('item').reviewDate ?? null, null); assert.equal(record('item').reviewDateUtc, null);
  assert.equal(record('clarification').step, 4);
  assert.equal(documents.filter(doc => doc.kind === 'record').length, 2);
  const state = await local(page), exported = deviceExport('alice', state, state.draft);
  assert.deepEqual(validateDeviceExport(exported).warnings, []);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)).state.records['clarification:insurance'].answers, record('clarification').answers);
  assert.match(readableExport(exported), /Coverage in place/);
  assert.match(readableExport(exported), /skipped/);
  const second = await browser.newContext(); const tab = await second.newPage();
  await tab.goto(url + '/#work'); await tab.locator('#workspace').waitFor(); await tab.locator('#view').selectOption('all'); await clickControl(tab.getByRole('button', { includeHidden: true, name: 'Clarify Call the insurer', exact: true })); await question(tab, 4);
  assert.match(await tab.locator('#clarifyAnswers').textContent(), /Coverage in place/);
  assert.deepEqual(errors, []);
});

test('clarification browser: independent session conflicts preserve both proposals and use explicit resolution', { timeout: 60000 }, async t => {
  const { page, browser, url } = await browserSetup(t);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  await page.locator('#clarifySave').click();
  await waitForBrowser(page, async () => !!(await (await import('/inbox-store.js?v=1')).transact('alice')).records['clarification:insurance']);
  const second = await browser.newContext(); const tab = await second.newPage();
  await tab.goto(url + '/#work'); await tab.locator('#workspace').waitFor(); await tab.locator('#view').selectOption('all'); await clickControl(tab.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  await second.setOffline(true);
  await tab.locator('#clarifyForm [name=text]').fill('Laptop outcome');
  await tab.locator('#clarifyAccept').click(); await question(tab, 1); await tab.locator('#clarifyStop').click();
  await page.locator('#clarifyForm [name=text]').fill('Phone outcome');
  await page.locator('#clarifyAccept').click(); await question(page, 1); await page.locator('#clarifyStop').click(); await confirmed(page);
  await second.setOffline(false); await clickControl(tab.locator('#sync')); await tab.locator('#failure').waitFor();
  assert.match(await tab.locator('#comparison').textContent(), /Laptop outcome/);
  assert.match(await tab.locator('#comparison').textContent(), /Phone outcome/);
  assert.equal(record('clarification').answers.outcome.value, 'Phone outcome');
  tab.once('dialog', dialog => dialog.accept()); await tab.locator('#resolve').click(); await confirmed(tab);
  assert.equal(record('clarification').answers.outcome.value, 'Laptop outcome');
  assert.equal(record('item').title, 'sort out insurance');
});

test('clarification browser: storage failure exposes draft recovery and account switch clears private session content', { timeout: 60000 }, async t => {
  const { page, context, setUser } = await browserSetup(t);
  await page.evaluate(async () => {
    const { transact, enqueue } = await import('/inbox-store.js?v=1');
    await transact('alice', local => enqueue(local, 'alice', [{ type: 'item', id: 'other', action: 'create', expectedVersion: 0, fields: { title: 'Another task' } }]));
  });
  await clickControl(page.locator('#sync')); await page.getByRole('button', { name: 'Edit Another task', exact: true }).waitFor(); await confirmed(page);
  await context.setOffline(true);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify sort out insurance', exact: true }));
  await page.locator('#clarifyForm [name=text]').fill('Private outcome');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=1')).transact('alice')).draft.clarification?.proposal.text === 'Private outcome');
  await page.locator('#clarifyStop').click();
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Clarify Another task', exact: true }));
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), 'Private outcome');
  assert.match(await page.locator('#clarifyError').textContent(), /Save this proposal/);
  await page.evaluate(() => { window.originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.locator('#clarifyAccept').click(); await page.locator('#recovery').waitFor();
  assert.equal(await page.locator('#clarifier').isVisible(), false);
  assert.match(await page.locator('#recoveryText').inputValue(), /Private outcome/);
  assert.equal((await local(page)).queue.length, 0);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; });
  setUser('bob'); await context.setOffline(false); await clickControl(page.locator('#sync')); await confirmed(page);
  await page.waitForFunction(() => !document.querySelector('#items').textContent.includes('insurance'));
  assert.equal(await page.locator('#clarifyOriginal').textContent(), '');
  assert.equal(await page.locator('#clarifyForm [name=text]').inputValue(), '');
  assert.equal(await page.locator('#recoveryText').inputValue(), '');
});
