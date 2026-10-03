import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents, faults, startServer } from './harness.mjs';

const token = 'a'.repeat(64);
async function fixture(t) {
  documents.length = 0; Object.assign(faults, { nextWrite: false, batchIndex: -1, loseBatchResponse: false });
  const server = await startServer(); t.after(server.close);
  const request = async (path, user = 'alice', body) => {
    const response = await fetch(server.url + '/api/shared/' + path, { method: body ? 'POST' : 'GET',
      headers: { origin: server.url, 'content-type': 'application/json', 'x-ms-client-principal': Buffer.from(JSON.stringify({ userId: user, userDetails: user, userRoles: ['authenticated'] })).toString('base64') }, body: body && JSON.stringify(body) });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return { status: response.status, body: await response.json() };
  };
  let seq = 0;
  const op = (action, fields, revision, user = 'alice', extra = {}) => ({ accountId: user, listId: 'shopping', operationId: 'op-' + ++seq, expectedRevision: revision, action, fields, ...extra });
  const post = body => request('operations', body.accountId, body);
  const get = user => request('list?id=shopping', user);
  const revision = () => documents.find(d => d.kind === 'shared-list')?.revision || 0;
  const act = (action, fields, user = 'alice') => post(op(action, fields, revision(), user));
  assert.equal((await act('create', { title: 'Groceries' })).status, 200);
  return { request, op, post, get, revision, act };
}
async function join(f, permissions = ['view'], user = 'bob') {
  assert.equal((await f.act('invite', { id: 'invitation-' + user, token: token + user, permissions })).status, 200);
  assert.equal((await f.act('join', { token: token + user }, user)).status, 200);
}

test('shared lists: each permission is enforced server-side and private data never enters snapshots', async t => {
  const f = await fixture(t); await join(f);
  assert.equal((await f.act('add', { id: 'milk', title: '<img src=x onerror=alert(1)>' })).status, 200);
  assert.equal((await f.get('outsider')).status, 403);
  assert.deepEqual((await f.request('lists', 'outsider')).body.lists, []);
  const visible = (await f.get('bob')).body.list;
  assert.equal(visible.items.length, 1); assert.equal(visible.owner, false);
  assert.equal(visible.members, undefined); assert.equal(visible.invitations, undefined);
  const cases = { add: ['add', { id: 'bread', title: 'Bread' }], edit: ['edit', { id: 'milk', title: 'Oat milk' }], complete: ['complete', { id: 'milk', completed: true }], delete: ['delete', { id: 'milk' }] };
  for (const [right, [action, fields]] of Object.entries(cases)) {
    const before = structuredClone(documents);
    assert.equal((await f.act(action, fields, 'bob')).status, 403, right);
    assert.deepEqual(documents, before, 'denied operation must not write even a receipt');
    assert.equal((await f.act('permissions', { accountId: 'bob', permissions: ['view', right] })).status, 200);
    assert.equal((await f.act(action, fields, 'bob')).status, 200, right);
    assert.equal((await f.act('permissions', { accountId: 'bob', permissions: ['view'] })).status, 200);
  }
  assert.equal((await f.act('restoreItem', { id: 'milk' }, 'bob')).status, 403);
  for (const [action, fields] of [['rename', { title: 'Hijack' }], ['invite', { id: 'bad', token, permissions: ['view'] }], ['revoke', { accountId: 'alice' }], ['deleteList', {}]]) {
    assert.equal((await f.act(action, fields, 'bob')).status, 403, action);
  }
  assert.equal((await f.act('restoreItem', { id: 'milk' })).status, 200);
  assert.equal((await f.get('alice')).body.list.items.find(i => i.id === 'milk').title, 'Oat milk');
  assert.equal((await f.request('lists', 'bob')).body.lists.length, 1);
  const invalid = f.op('edit', { id: 'milk', title: 'x', ownerId: 'bob', projectId: 'private' }, f.revision());
  assert.equal((await f.post(invalid)).status, 400);
  assert.equal((await f.act('permissions', { accountId: 'bob', permissions: ['edit'] })).status, 400);
  assert.equal((await f.act('rename', { title: 'Unsupported\u0000text' })).status, 400);
});

test('shared lists: single-use invitations, cancellation, expiry, revocation and deletion/restore', async t => {
  const f = await fixture(t);
  assert.equal((await f.act('join', { token }, 'bob')).status, 403);
  await f.act('invite', { id: 'expired', token, permissions: ['view'] });
  documents.find(d => d.kind === 'shared-list').invitations[0].expiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await f.act('join', { token }, 'bob')).status, 403);
  await f.act('invite', { id: 'cancel', token: token + 'cancel', permissions: ['view'] });
  await f.act('cancelInvite', { id: 'cancel' });
  assert.equal((await f.act('join', { token: token + 'cancel' }, 'bob')).status, 403);
  await join(f, ['view', 'add', 'edit', 'delete', 'complete']);
  assert.equal((await f.act('join', { token: token + 'bob' }, 'eve')).status, 403);
  const queued = f.op('add', { id: 'offline', title: 'Offline text' }, f.revision(), 'bob');
  await f.act('revoke', { accountId: 'bob' });
  assert.equal((await f.post(queued)).status, 403);
  assert.equal((await f.get('bob')).status, 403);
  assert.deepEqual((await f.request('lists', 'bob')).body.lists, []);
  await f.act('add', { id: 'milk', title: 'Milk' });
  await join(f, ['view'], 'carol');
  const deleted = f.op('deleteList', {}, f.revision());
  assert.equal((await f.post(deleted)).status, 200);
  assert.equal((await f.post(deleted)).status, 200);
  assert.equal((await f.get('carol')).status, 403);
  assert.equal((await f.act('add', { id: 'bad', title: 'Stale' })).status, 409);
  assert.equal((await f.act('restoreList', {})).status, 200);
  const restored = (await f.get('alice')).body.list;
  assert.equal(restored.items[0].title, 'Milk'); assert.equal(restored.members.length, 0);
  assert.equal((await f.get('carol')).status, 403, 'restore must not silently regrant access');
  assert.equal((await f.post(deleted)).status, 200, 'receipt replay cannot delete the restored list');
  assert.equal((await f.get('alice')).body.list.deleted, false);
});

test('shared lists: lost acknowledgements, changed-content retry, concurrent writes and grants are atomic', async t => {
  const f = await fixture(t); await join(f, ['view', 'add']);
  const op = f.op('add', { id: 'milk', title: 'Milk' }, f.revision(), 'bob');
  faults.loseBatchResponse = true;
  assert.equal((await f.post(op)).status, 503);
  const receipt = await f.post(op);
  assert.equal(receipt.status, 200); assert.deepEqual(await f.post(op), receipt);
  assert.equal((await f.post({ ...op, fields: { ...op.fields, title: 'Different' } })).body.error, 'operation_reused');
  assert.equal((await f.get('bob')).body.list.items.length, 1);
  const rev = f.revision();
  const results = await Promise.all([f.post(f.op('add', { id: 'bread', title: 'Bread' }, rev, 'bob')), f.post(f.op('revoke', { accountId: 'bob' }, rev))]);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  if ((await f.get('bob')).status === 200) await f.act('revoke', { accountId: 'bob' });
  assert.equal((await f.post(op)).status, 403, 'revoked users cannot replay receipts');
  const before = structuredClone(documents);
  faults.batchIndex = 1;
  assert.equal((await f.act('add', { id: 'failed', title: 'Never committed' })).status, 503);
  assert.deepEqual(documents, before);
});

test('shared lists: join retry after lost acknowledgement and account mismatch do not leak data', async t => {
  const f = await fixture(t);
  await f.act('invite', { id: 'join', token, permissions: ['view'] });
  const op = f.op('join', { token }, 0, 'bob');
  faults.loseBatchResponse = true;
  assert.equal((await f.post(op)).status, 503);
  assert.equal((await f.post(op)).status, 200);
  assert.equal((await f.get('alice')).body.list.members.length, 1);
  assert.equal((await f.request('operations', 'eve', op)).body.error, 'account_mismatch');
  const response = JSON.stringify((await f.get('alice')).body);
  assert.ok(!response.includes(token)); assert.ok(!response.includes('tokenHash'));
  assert.equal((await f.act('create', { title: 'Guess ID' }, 'eve')).status, 403);
  assert.equal((await f.act('add', { id: 'oversize', title: 'x'.repeat(10000) })).status, 413);
});

test('shared lists: create retry is repeat-safe and paged discovery never admits an outsider', async t => {
  const f = await fixture(t);
  const create = f.op('create', { title: 'Second shared list' }, 0, 'alice', { listId: 'second' });
  faults.loseBatchResponse = true;
  assert.equal((await f.post(create)).status, 503);
  const receipt = await f.post(create);
  assert.equal(receipt.status, 200); assert.deepEqual(await f.post(create), receipt);
  const template = documents.find(d => d.kind === 'shared-list');
  for (let i = 0; i < 55; i++) documents.push({ ...structuredClone(template), listId: 'page-' + i, UserID: 'shared:page-' + i });
  const first = (await f.request('lists')).body;
  assert.equal(first.lists.length, 50); assert.ok(first.cursor);
  const second = (await f.request('lists?cursor=' + encodeURIComponent(first.cursor))).body;
  assert.equal(second.lists.length, 7); assert.equal(second.cursor, null);
  assert.deepEqual((await f.request('lists?cursor=' + encodeURIComponent(first.cursor), 'eve')).body.lists, []);
  const limit = documents.find(d => d.kind === 'shared-list');
  limit.items = Array.from({ length: 200 }, (_, i) => ({ id: 'item-' + i, title: 'Item', completed: false, deleted: true }));
  assert.equal((await f.act('add', { id: 'overflow', title: 'No silent purge' })).status, 400);
  assert.equal(limit.items.length, 200);
});
