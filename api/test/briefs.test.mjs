import { clickControl } from './navigation-helper.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import { documents, faults, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { templateBrief, readableBrief } from '../../html/briefs.js';
import { briefFields } from '../api/v1/briefs.mjs';
import { deviceExport, readableExport, validateDeviceExport } from '../../html/inbox-export.js';

const item = { type: 'item', id: 'insurance', version: 1, title: 'Call the insurer', originalText: 'sort out insurance', sourceUrl: 'https://example.com/policy' };
const fields = () => ({ subjectType: 'item', subjectId: item.id, sourceVersion: 1, previousBriefId: null, status: 'draft', content: templateBrief(item) });
const mutation = (type, id, version, fields, action = version ? 'update' : 'create') => {
  const next = fields && action === 'create' ? { ...fields,
    ...(['item', 'list', 'project', 'review'].includes(type) ? { workspaceId: fields.workspaceId ?? 'personal' } : {}),
    ...(type === 'item' ? { status: fields.status ?? 'inbox', collectionRefs: fields.collectionRefs ?? [] } : {}),
    ...(type === 'project' ? { status: fields.status ?? 'active' } : {}) } : fields;
  return { type, id, expectedVersion: version, action, ...(next ? { fields: next } : {}) };
};
const record = id => documents.find(doc => doc.UserID === 'alice' && doc.id === `record:brief:${id}`)?.record;
async function post(url, mutations, operationId = crypto.randomUUID(), user = 'alice') {
  const response = await fetch(url + '/api/v1/operations', { method: 'POST', headers: { origin: url, 'content-type': 'application/json',
    'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: user, userRoles: ['authenticated'] })).toString('base64') },
    body: JSON.stringify({ apiVersion: 1, accountId: user, operationId, mutations }) });
  return { status: response.status, body: await response.json() };
}
const seed = url => post(url, [mutation('item', item.id, 0, { title: item.title, originalText: item.originalText, sourceUrl: item.sourceUrl })]);

test('brief API: immutable revisions, explicit decisions, retries, conflicts, source ownership and deletion', async t => {
  documents.length = 0; const server = await startServer(); t.after(server.close);
  const save = (mutations, id, user) => post(server.url, mutations, id, user);
  assert.equal((await save([mutation('brief', 'r1', 0, fields())])).status, 400);
  await seed(server.url);
  assert.equal((await save([mutation('brief', 'r1', 0, fields())], undefined, 'bob')).status, 400);
  assert.equal((await save([mutation('brief', 'r1', 0, { ...fields(), status: 'accepted' })])).status, 400);
  assert.equal((await save([mutation('brief', 'r1', 0, { ...fields(), sourceVersion: 2 })])).status, 400);
  faults.loseBatchResponse = true;
  const create = [mutation('brief', 'r1', 0, fields())];
  assert.equal((await save(create, 'lost-brief')).status, 503);
  const receipt = await save(create, 'lost-brief'); assert.equal(receipt.status, 200);
  assert.deepEqual(await save(create, 'lost-brief'), receipt);
  assert.equal((await save([mutation('brief', 'r1', 1, { content: { ...fields().content, outcome: 'Tampered' }, status: 'accepted' })])).status, 400);
  assert.equal((await save([mutation('brief', 'r1', 1, { status: 'accepted' })])).status, 200);
  assert.equal((await save([mutation('brief', 'r1', 1, { status: 'rejected' })])).status, 409);
  assert.equal((await save([mutation('brief', 'r1', 2, { status: 'rejected' })])).status, 400);
  assert.equal((await save([mutation('brief', 'r1', 2, undefined, 'delete')])).status, 400);
  const edited = { ...fields(), previousBriefId: 'r1', content: { ...fields().content, outcome: 'Coverage confirmed', missingInformation: 'None known' } };
  assert.equal((await save([mutation('brief', 'r2', 0, edited)])).status, 200);
  assert.equal(record('r1').status, 'accepted'); assert.equal(record('r2').status, 'draft');
  assert.notEqual(record('r1').content.outcome, record('r2').content.outcome);
  assert.equal((await save([mutation('brief', 'r2', 1, { status: 'rejected' })])).status, 200);
  assert.equal((await save([mutation('brief', 'r2', 2, { status: 'accepted' })])).status, 400);
  await post(server.url, [mutation('item', item.id, 0, { title: 'Bob source' })], undefined, 'bob');
  assert.equal((await save([mutation('brief', 'r3', 0, edited)], undefined, 'bob')).status, 400);
  assert.equal((await save([mutation('brief', 'cycle', 0, { ...fields(), previousBriefId: 'cycle' })])).status, 400);
  assert.equal((await save([mutation('item', item.id, 1, { title: 'Updated task' })])).status, 200);
  assert.equal((await save([mutation('brief', 'stale', 0, fields())])).status, 400);
  assert.equal((await save([mutation('brief', 'r3', 0, edited)])).status, 200, 'an edited historical revision retains its original source version');
  assert.equal((await save([mutation('item', item.id, 2, undefined, 'delete')])).status, 200);
  assert.equal((await save([mutation('brief', 'r4', 0, edited)])).status, 400);
  assert.equal(record('r1').status, 'accepted', 'source deletion does not erase accepted history');
});

test('brief templates use accepted facts, retain unknowns and export exact revision status', () => {
  const clarification = { flowVersion: 2, answers: { project: { choice: 'new', projectTitle: 'Insurance', outcome: 'Coverage in place' }, organize: { notes: 'Confirm the policy number' } }, proposal: { text: 'Unaccepted claim' } };
  const generated = templateBrief(item, clarification);
  assert.equal(generated.outcome, 'Coverage in place'); assert.match(generated.context, /https:\/\/example.com\/policy/);
  assert.match(generated.missingInformation, /Confirm the policy number/); assert.ok(!JSON.stringify(generated).includes('Unaccepted claim'));
  assert.equal(templateBrief({ ...item, type: 'project', outcome: 'Launch complete' }).outcome, 'Launch complete');
  assert.match(templateBrief({ ...item, type: 'project' }).nextAction, /Unknown/);
  for (const change of [f => { f.content.missingInformation = ''; }, f => { f.content.outcome = 'a'.repeat(4001); }, f => { f.content.extra = 'x'; }, f => { f.sourceVersion = 0; }]) {
    const f = fields(); change(f); assert.throws(() => briefFields('create', f));
  }
  const revision = { ...fields(), id: 'r1', type: 'brief', version: 2, accountId: 'alice', deleted: false, status: 'accepted' };
  assert.match(readableBrief(revision), /ACCEPTED REVISION/);
  assert.match(readableBrief({ ...revision, status: 'draft' }), /DRAFT — NOT ACCEPTED/);
  assert.match(readableBrief({ ...revision, localState: 'Saved on device — pending' }), /UNCONFIRMED REVISION/);
  const exported = deviceExport('alice', { records: { 'brief:r1': revision }, after: 1, queue: [], draft: {} }, {});
  assert.deepEqual(validateDeviceExport(JSON.parse(JSON.stringify(exported))).warnings, []);
  assert.match(readableExport(exported), /Revision ID: r1/);
  assert.deepEqual(JSON.parse(JSON.stringify(exported)).state.records['brief:r1'], revision);
});

const confirmed = page => page.waitForFunction(() => document.querySelector('#syncStatus').textContent === 'All saved work is server-confirmed.');
async function confirmedRevision(page, status) {
  // The global idle message can still describe the state before the click's save.
  await waitForBrowser(page, async status => {
    const id = document.querySelector('#briefRevisions').value;
    const state = await (await import('/inbox-store.js?v=8')).transact('alice');
    return !!id && state.records[`brief:${id}`]?.status === status &&
      !state.queue.some(entry => entry.operation.mutations.some(mutation => mutation.type === 'brief' && mutation.id === id));
  }, status);
  await confirmed(page);
}
const local = page => page.evaluate(async () => (await import('/inbox-store.js?v=8')).transact('alice'));
async function setup(t) {
  documents.length = 0; let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close); await seed(server.url);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); await page.goto(server.url + '/#work'); await confirmed(page);
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent === 'Ready to reopen this inbox offline.');
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Brief Call the insurer', exact: true }));
  return { page, context, browser, url: server.url, setUser: value => { user = value; } };
}
async function download(page) {
  const pending = page.waitForEvent('download'); await page.locator('#briefExport').click();
  return readFile(await (await pending).path(), 'utf8');
}

test('brief browser: offline edit/resume, revision-specific decisions, export, project template and account clearing', { timeout: 90000 }, async t => {
  const { page, context, browser, url, setUser } = await setup(t);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await context.setOffline(true);
  await page.locator('#briefForm [name=outcome]').fill('Coverage in place');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=8')).transact('alice')).draft.brief?.content.outcome === 'Coverage in place');
  await page.reload(); await page.locator('#briefs').waitFor();
  assert.equal(await page.locator('#briefForm [name=outcome]').inputValue(), 'Coverage in place');
  assert.equal(await page.locator('#briefAccept').isDisabled(), true);
  await page.getByRole('button', { name: 'Save new draft revision' }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=8')).transact('alice')).queue.length === 1);
  await page.locator('#briefAccept').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=8')).transact('alice')).queue.length === 2);
  assert.match(await download(page), /UNCONFIRMED REVISION/);
  await context.setOffline(false); await page.locator('#closeBriefs').click(); await clickControl(page.locator('#sync')); await confirmedRevision(page, 'accepted');
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Brief Call the insurer', exact: true }));
  const first = await page.locator('#briefRevisions').inputValue();
  assert.match(await download(page), /ACCEPTED REVISION/);
  await page.locator('#briefForm [name=outcome]').fill('Changed scope');
  assert.equal(await page.locator('#briefExport').isDisabled(), true);
  assert.equal(await page.locator('#briefAccept').isDisabled(), true);
  await page.getByRole('button', { name: 'Save new draft revision' }).click();
  await page.waitForFunction(first => document.querySelector('#briefRevisions').value !== first, first); await confirmedRevision(page, 'draft');
  assert.match(await download(page), /DRAFT — NOT ACCEPTED/);
  await page.locator('#briefReject').click(); await confirmedRevision(page, 'rejected');
  await page.waitForFunction(() => document.querySelector('#briefState').textContent.startsWith('rejected'));
  await page.waitForFunction(() => document.activeElement.id === 'briefState');
  assert.equal(await page.locator('#briefAccept').isDisabled(), true);
  await page.locator('#briefRevisions').selectOption(first);
  assert.equal(await page.locator('#briefForm [name=outcome]').inputValue(), 'Coverage in place');
  assert.match(await download(page), /ACCEPTED REVISION/);
  if (process.env.BRIEF_SCREENSHOTS) {
    await mkdir(process.env.BRIEF_SCREENSHOTS, { recursive: true }); console.log('Brief evidence browser:', browser.version());
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#briefs').evaluate(dialog => { dialog.scrollTop = 0; });
      await page.screenshot({ path: `${process.env.BRIEF_SCREENSHOTS}/brief-${width}.png` });
    }
  }
  await page.locator('#closeBriefs').click();
  await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Brief Call the insurer');
  await post(url, [mutation('project', 'launch', 0, { title: 'Launch', outcome: 'Launch complete' })]);
  await clickControl(page.locator('#sync'));
  await waitForBrowser(page, async () => !!(await (await import('/inbox-store.js?v=8')).transact('alice')).records['project:launch']);
  await page.locator('#view').selectOption('project:launch');
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Brief Launch', exact: true }));
  assert.equal(await page.locator('#briefForm [name=outcome]').inputValue(), 'Launch complete');
  await page.locator('#closeBriefs').click(); setUser('bob'); await clickControl(page.locator('#sync')); await confirmed(page);
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=8')).transact(null)).accountId === 'bob' && !document.querySelector('#workspace').hidden);
  assert.equal(await page.locator('#briefOriginal').textContent(), '');
  assert.equal(await page.locator('#briefForm [name=outcome]').inputValue(), '');
  assert.deepEqual(errors, []);
});

test('brief browser: competing decisions and storage failure retain recoverable drafts', { timeout: 60000 }, async t => {
  const { page, context, url } = await setup(t);
  await page.getByRole('button', { name: 'Save new draft revision' }).click(); await confirmedRevision(page, 'draft');
  const id = await page.locator('#briefRevisions').inputValue();
  await context.setOffline(true); await page.locator('#briefAccept').click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=8')).transact('alice')).queue.length === 1);
  assert.equal((await post(url, [mutation('brief', id, 1, { status: 'rejected' })])).status, 200);
  await page.locator('#closeBriefs').click(); await context.setOffline(false); await clickControl(page.locator('#sync')); await page.locator('#failure').waitFor();
  assert.equal(record(id).status, 'rejected'); assert.equal((await local(page)).queue.length, 1);
  assert.equal(await page.locator('#resolve').isVisible(), false);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#discard').click(); await confirmed(page);
  await clickControl(page.getByRole('button', { includeHidden: true, name: 'Brief Call the insurer', exact: true }));
  await page.locator('#briefForm [name=outcome]').fill('Private recovery text');
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=8')).transact('alice')).draft.brief?.content.outcome === 'Private recovery text');
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: 'Save new draft revision' }).click(); await page.locator('#recovery').waitFor();
  assert.match(await page.locator('#recoveryText').inputValue(), /Private recovery text/);
  assert.equal((await local(page)).queue.length, 0);
});
