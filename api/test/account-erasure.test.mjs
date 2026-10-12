import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { applyAccountErasure, createAccountErasurePlan, accountErasureFenceId } from '../api/v1/account-erasure.mjs';
import { container, documents, startServer } from './harness.mjs';
import { waitForBrowser } from './browser-wait.mjs';
import { document, recordId } from '../api/v1/contract.mjs';

const principal = user => Buffer.from(JSON.stringify({ userId: user, userDetails: `${user} name`, userRoles: ['authenticated'] })).toString('base64');
async function request(server, path, user, body) {
  const response = await fetch(server.url + path, { method: body ? 'POST' : 'GET', headers: {
    origin: server.url, 'content-type': 'application/json', 'x-ms-client-principal': principal(user)
  }, body: body && JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const mutation = (type, id, fields, action = 'create', expectedVersion = 0) => ({ type, id, action, expectedVersion, ...(fields ? { fields } : {}) });
const privateOperation = (accountId, operationId, mutations) => ({ apiVersion: 1, accountId, operationId, mutations });
const sharedOperation = (accountId, listId, operationId, expectedRevision, action, fields) => ({ accountId, listId, operationId, expectedRevision, action, fields });

test('account erasure: exact plan fences all routes, purges private/shared data, resumes and isolates other accounts', async t => {
  documents.length = 0;
  const server = await startServer(); t.after(server.close);
  const postPrivate = (user, id, mutations) => request(server, '/api/v1/operations', user, privateOperation(user, id, mutations));
  const postShared = (user, list, id, revision, action, fields) => request(server, '/api/shared/operations', user, sharedOperation(user, list, id, revision, action, fields));
  assert.equal((await postPrivate('alice', 'alice-create', [
    mutation('workspace', 'work', { title: 'Private employer name' }),
    mutation('item', 'personal-task', { title: 'Personal secret', workspaceId: 'personal', collectionRefs: [], status: 'inbox' }),
    mutation('item', 'work-task', { title: 'Work secret', workspaceId: 'work', collectionRefs: [], status: 'inbox' })
  ])).status, 200);
  assert.equal((await postPrivate('alice', 'alice-delete', [mutation('item', 'work-task', null, 'delete', 1)])).status, 200);
  const derivedTypes = ['settings', 'list', 'project', 'savedView', 'review', 'reviewDecision', 'reviewReflection', 'clarification', 'brief',
    'planPreference', 'dailyPlan', 'dailyPlanRevision', 'projectPlanRevision', 'recurrenceTemplate', 'executionPolicy'];
  for (const [index, type] of derivedTypes.entries()) await container.items.create(document('alice', recordId(type, `derived-${index}`), {
    kind: 'record', record: { type, id: `derived-${index}`, accountId: 'alice', title: `Derived secret ${index}`, version: 1, deleted: index === 0 }
  }));
  await container.items.create(document('alice', 'workspace-erasure:old', { kind: 'workspace-erasure', workspaceId: 'old', erasureId: 'old-decision', status: 'complete' }));
  assert.equal((await postPrivate('bob', 'bob-create', [mutation('item', 'bob-task', { title: 'Bob remains', workspaceId: 'personal', collectionRefs: [], status: 'inbox' })])).status, 200);

  const invite = 'a'.repeat(64), invite2 = 'b'.repeat(64), invite3 = 'c'.repeat(64);
  assert.equal((await postShared('alice', 'alice-owned', 'ao-create', 0, 'create', { title: 'Alice owned' })).status, 200);
  assert.equal((await postShared('alice', 'alice-owned', 'ao-invite', 1, 'invite', { id: 'invite-bob', token: invite, permissions: ['view'] })).status, 200);
  assert.equal((await postShared('bob', 'alice-owned', 'ao-join', 0, 'join', { token: invite })).status, 200);
  assert.equal((await postShared('bob', 'bob-owned', 'bo-create', 0, 'create', { title: 'Bob owned' })).status, 200);
  assert.equal((await postShared('bob', 'bob-owned', 'bo-add', 1, 'add', { id: 'retained-item', title: 'Collaborative content stays' })).status, 200);
  assert.equal((await postShared('bob', 'bob-owned', 'bo-invite-a', 2, 'invite', { id: 'invite-alice', token: invite2, permissions: ['view', 'add'] })).status, 200);
  assert.equal((await postShared('alice', 'bob-owned', 'bo-join-a', 0, 'join', { token: invite2 })).status, 200);
  assert.equal((await postShared('bob', 'bob-owned', 'bo-invite-c', 4, 'invite', { id: 'invite-carol', token: invite3, permissions: ['view'] })).status, 200);
  assert.equal((await postShared('carol', 'bob-owned', 'bo-join-c', 0, 'join', { token: invite3 })).status, 200);
  assert.equal((await postShared('alice', 'bob-owned', 'alice-shared-add', 6, 'add', { id: 'alice-item', title: 'Collaborative Alice text retained' })).status, 200);

  const bobBefore = structuredClone(documents.filter(row => row.UserID === 'bob'));
  const plan = await createAccountErasurePlan(container, 'alice', {
    authenticatedPrincipalId: 'alice', backupExpiresAfterUtc: '2026-12-01T00:00:00.000Z', erasureId: 'erase-alice-1', plannedUtc: '2026-10-12T00:00:00.000Z'
  });
  const evidence = JSON.stringify(plan);
  for (const privateValue of ['Private employer name', 'Personal secret', 'Work secret', 'Derived secret', 'personal-task', 'alice-create', 'alice-owned', 'bob-owned']) {
    assert.equal(evidence.includes(privateValue), false);
  }
  assert.equal(plan.counts.privateRecords, 3 + derivedTypes.length);
  assert.equal(plan.counts.sharedOwnedLists, 1);
  assert.equal(plan.counts.sharedMemberships, 1);
  await assert.rejects(applyAccountErasure(container, plan, { confirm: plan.erasureId, interruptAfter: 'private' }), { code: 'interrupted' });
  assert.equal(documents.find(row => row.UserID === 'alice' && row.id === accountErasureFenceId).status, 'erasing');

  const stalePrivate = await postPrivate('alice', 'stale-private', [mutation('item', 'resurrect', { title: 'Must not return', workspaceId: 'personal', collectionRefs: [], status: 'inbox' })]);
  assert.equal(stalePrivate.status, 410); assert.equal(stalePrivate.body.error, 'account_erased');
  const staleShared = await postShared('alice', 'bob-owned', 'stale-shared', 7, 'add', { id: 'late', title: 'Must not return' });
  assert.equal(staleShared.status, 410); assert.equal(staleShared.body.error, 'account_erased');
  for (const path of ['/api/v1/session', '/api/v1/changes?accountId=alice&after=0&limit=50', '/api/v1/export?accountId=alice&after=0&limit=50', '/api/v1/ai/status', '/api/shared/lists']) {
    assert.equal((await request(server, path, 'alice')).status, 410, path);
  }
  assert.equal((await request(server, '/api/v1/ai/suggestions', 'alice', { kind: 'clarification', prompt: 'stale private prompt' })).status, 410);

  const outcome = await applyAccountErasure(container, plan, { confirm: plan.erasureId, now: '2026-10-12T01:00:00.000Z' });
  assert.equal(outcome.status, 'complete');
  assert.equal(JSON.stringify(outcome).includes('Personal secret'), false);
  assert.deepEqual(documents.filter(row => row.UserID === 'alice').map(row => row.id), [accountErasureFenceId]);
  assert.deepEqual(documents.filter(row => row.UserID === 'bob'), bobBefore);
  assert.equal(documents.some(row => row.UserID === 'shared:alice-owned'), false);
  const retained = documents.find(row => row.UserID === 'shared:bob-owned' && row.id === 'list');
  assert.deepEqual(retained.items.map(item => item.title), ['Collaborative content stays', 'Collaborative Alice text retained']);
  assert.deepEqual(retained.members.map(member => member.accountId), ['carol']);
  assert.equal(documents.some(row => row.UserID === 'shared:bob-owned' && row.kind === 'shared-receipt' && row.response.accountId === 'alice'), false);
  assert.equal(documents.some(row => row.UserID === 'shared:bob-owned' && row.kind === 'shared-receipt' && row.response.accountId === 'bob'), true);
  assert.equal(await applyAccountErasure(container, plan, { confirm: plan.erasureId }).then(result => result.status), 'complete');
  await assert.rejects(applyAccountErasure(container, { ...plan, erasureId: 'another-decision' }, { confirm: 'another-decision' }), { code: 'different_erasure' });
});

test('account erasure: retained decision reapplies to a disabled restored snapshot and preserves post-backup work for other accounts', async () => {
  documents.length = 0;
  await container.items.create(document('alice', 'state', { kind: 'state', sequence: 1 }));
  await container.items.create(document('alice', recordId('item', 'old-a'), { kind: 'record', record: { type: 'item', id: 'old-a', accountId: 'alice', title: 'Old A', version: 1 } }));
  await container.items.create(document('bob', 'state', { kind: 'state', sequence: 1 }));
  await container.items.create(document('bob', recordId('item', 'old-b'), { kind: 'record', record: { type: 'item', id: 'old-b', accountId: 'bob', title: 'Old B', version: 1 } }));
  const shared = { id: 'list', UserID: 'shared:restored', ObjectType: 'shared-list', ObjectID: 'v1', ttl: -1, kind: 'shared-list', listId: 'restored',
    ownerId: 'bob', title: 'Restored list', revision: 1, deleted: false, items: [{ id: 'kept', title: 'Keep', completed: false, deleted: false }],
    members: [{ accountId: 'alice', name: 'Alice old name', permissions: ['view'] }], invitations: [] };
  await container.items.create(shared);
  const snapshot = structuredClone(documents);
  const plan = await createAccountErasurePlan(container, 'alice', { authenticatedPrincipalId: 'alice', backupExpiresAfterUtc: '2026-12-01T00:00:00.000Z' });
  await applyAccountErasure(container, plan, { confirm: plan.erasureId });

  documents.splice(0, documents.length, ...snapshot);
  await container.items.create(document('alice', recordId('item', 'post-backup-a'), { kind: 'record', record: { type: 'item', id: 'post-backup-a', accountId: 'alice', title: 'Late A', version: 1 } }));
  await container.items.create(document('bob', recordId('item', 'post-backup-b'), { kind: 'record', record: { type: 'item', id: 'post-backup-b', accountId: 'bob', title: 'Late B', version: 1 } }));
  const outcome = await applyAccountErasure(container, plan, { confirm: plan.erasureId, restoreReplay: true });
  assert.equal(outcome.actualCounts.privateRecords, 2);
  assert.deepEqual(documents.filter(row => row.UserID === 'alice').map(row => row.id), [accountErasureFenceId]);
  assert.deepEqual(documents.filter(row => row.UserID === 'bob' && row.kind === 'record').map(row => row.record.title).sort(), ['Late B', 'Old B']);
  const retained = documents.find(row => row.UserID === 'shared:restored' && row.id === 'list');
  assert.deepEqual(retained.members, []); assert.equal(retained.items[0].title, 'Keep');
});

test('account erasure: offline device purges only the erased profile before submitting its queue', { timeout: 180000 }, async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(server.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent.includes('Ready to reopen'), null, { timeout: 120000 });
  await page.locator('#captureText').fill('Server task'); await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=19')).transact('alice')).queue.length === 0);
  await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=19');
    await store.transact('bob', state => { state.records['item:bob'] = { type: 'item', id: 'bob', accountId: 'bob', title: 'Bob local', version: 1, deleted: false }; });
    await store.transact('alice', state => { state.sharedLists = { lists: {}, directory: [], drafts: { secret: { add: 'Shared draft' } }, selected: '',
      pending: { operation: { accountId: 'alice', listId: 'secret', operationId: 'shared-pending', expectedRevision: 1, action: 'add', fields: { id: 'late', title: 'Shared pending' } } } }; });
  });
  const plan = await createAccountErasurePlan(container, 'alice', { authenticatedPrincipalId: 'alice', backupExpiresAfterUtc: '2026-12-01T00:00:00.000Z' });
  await context.setOffline(true);
  await page.locator('#captureText').fill('Offline pending'); await page.getByRole('button', { name: 'Save on device', exact: true }).click();
  await waitForBrowser(page, async () => (await (await import('/inbox-store.js?v=19')).transact('alice')).queue.length === 1);
  await applyAccountErasure(container, plan, { confirm: plan.erasureId });
  await page.goto(server.url + '/#data-recovery/export'); await page.locator('#workspace').waitFor();
  assert.equal((await page.evaluate(async () => (await (await import('/inbox-store.js?v=19')).transact('alice')).queue.length)), 1);
  await context.setOffline(false);
  await waitForBrowser(page, async () => {
    const store = await import('/inbox-store.js?v=19'), session = await store.transact(null), alice = await store.transact('alice');
    return session.paused && !session.accountId && alice.queue.length === 0 && Object.keys(alice.records).length === 0 && alice.sharedLists === undefined &&
      document.querySelector('#sessionStatus').textContent.startsWith('Account erased');
  });
  const bob = await page.evaluate(async () => (await (await import('/inbox-store.js?v=19')).transact('bob')).records['item:bob']);
  assert.equal(bob.title, 'Bob local');
  const isolated = await page.evaluate(async () => {
    const store = await import('/inbox-store.js?v=19');
    await store.transact('charlie', profile => { profile.draft.capture = { text: 'Charlie only' }; });
    await store.transact(null, session => { session.accountId = 'bob'; session.activeProfile = 'bob'; session.paused = false; });
    await store.purgeAccountProfile('charlie');
    return { session: await store.transact(null), charlie: await store.transact('charlie') };
  });
  assert.equal(isolated.session.accountId, 'bob'); assert.equal(isolated.session.paused, false);
  assert.equal(isolated.charlie.draft.capture, undefined);
  assert.equal(new URL(page.url()).hash, '#capture');
  assert.equal(await page.locator('#captureHeading').evaluate(element => element === document.activeElement), true);
  assert.equal(documents.some(row => row.UserID === 'alice' && row.id === 'receipt:' + plan.erasureId), false);
});
