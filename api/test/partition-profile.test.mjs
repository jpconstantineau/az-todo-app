import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents } from './harness.mjs';
import { validateOperation, bytes } from '../api/v1/contract.mjs';
const { commit, changes } = await import('../api/v1/store.mjs');

test('partition profile: retained history growth, bounded pagination and account contention', async t => {
  documents.length = 0;
  const operation = (id, version, accountId = 'profile-account') => validateOperation({
    apiVersion: 1, accountId, operationId: `op-${id}-${version}`,
    mutations: [{ type: 'item', id: `item-${id}`, action: version ? 'update' : 'create', expectedVersion: version,
      fields: { title: `Task ${id} revision ${version}`, description: 'A representative task note. '.repeat(10),
        ...(!version ? { workspaceId: 'personal', collectionRefs: [] } : {}) } }]
  });
  const measure = () => Object.fromEntries(['record', 'receipt', 'change', 'state'].map(kind => {
    const rows = documents.filter(doc => doc.kind === kind);
    // Exclude the mock's ETag; this is serialized application JSON, not Cosmos billed storage.
    return [kind, { count: rows.length, bytes: rows.reduce((sum, { _etag, ...doc }) => sum + bytes(doc), 0) }];
  }));
  for (let id = 0; id < 100; id++) await commit('profile-account', operation(id, 0));
  const initial = measure();
  for (let version = 1; version <= 5; version++) {
    for (let id = 0; id < 100; id++) await commit('profile-account', operation(id, version));
  }
  const edited = measure();
  assert.equal(edited.record.count, 100);
  assert.equal(edited.receipt.count, 600);
  assert.equal(edited.change.count, 600);
  assert.ok(edited.change.bytes > initial.change.bytes * 5);
  let after = 0, pages = 0, payloadBytes = 0;
  do {
    const page = await changes('profile-account', after, 50);
    assert.equal(page.entries[0].sequence, after + 1);
    assert.ok(page.entries.length <= 50);
    after = page.nextAfter; pages++; payloadBytes += bytes(page);
    if (!page.hasMore) break;
  } while (true);
  assert.equal(after, 600); assert.equal(pages, 12);
  // Each contender changes a different record. The common state ETag still serializes them.
  const competing = await Promise.allSettled(Array.from({ length: 8 }, (_, id) => commit('profile-account', operation(id, 6))));
  const busy = competing.filter(result => result.status === 'rejected');
  assert.ok(busy.every(result => result.reason.code === 'account_busy'));
  assert.ok(busy.length > 0, 'bounded retries are visible under synchronized mock contention');
  for (let id = 0; id < competing.length; id++) if (competing[id].status === 'rejected') await commit('profile-account', operation(id, 6));
  assert.equal(documents.filter(doc => doc.kind === 'receipt').length, 608);
  const separate = await Promise.all(Array.from({ length: 8 }, (_, id) => commit(`account-${id}`, operation(id, 0, `account-${id}`))));
  assert.ok(separate.every(result => result.status === 'committed'));
  t.diagnostic(JSON.stringify({ initial, edited, pages, payloadBytes, contenders: 8, busy: busy.length,
    limits: 'In-memory storage; RU, index bytes and deployed latency are unmeasured.' }));
});
