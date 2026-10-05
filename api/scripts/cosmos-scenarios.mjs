import assert from 'node:assert/strict';
import { document, partition, recordId, validateOperation } from '../api/v1/contract.mjs';
import capture from '../test/fixtures/v1-operations.json' with { type: 'json' };

// The same scenarios run locally against the test store and, explicitly, against
// a fresh Cosmos database. No HTTP/authentication or backup-restore claim is made.
export async function protocolScenarios({ store, container, check }) {
  const { commit, read, changes } = store;
  const send = input => commit(input.accountId, validateOperation(input));
  const edit = (operationId, id, expectedVersion, fields, action = 'update') => ({
    apiVersion: 1, accountId: 'alice', operationId,
    mutations: [{ type: 'item', id, expectedVersion, action, ...(fields ? { fields: action === 'create'
      ? { ...fields, workspaceId: fields.workspaceId ?? 'personal', status: fields.status ?? 'inbox',
        collectionRefs: fields.collectionRefs ?? ['list', 'project'].filter(kind => fields[`${kind}Id`]).map(kind => ({ type: kind, id: fields[`${kind}Id`] })) }
      : fields } : {}) }]
  });
  const record = async id => (await read('alice', recordId('item', id)))?.record;

  await check('lost acknowledgement and concurrent duplicate delivery', async () => {
    await send(capture); // Deliberately discard the acknowledgement after commit.
    const receipt = (await read('alice', `receipt:${capture.operationId}`)).response;
    const replies = await Promise.all([send(capture), send(capture)]);
    replies.forEach(reply => assert.deepEqual(reply, receipt));
    assert.equal((await read('alice', 'state')).sequence, 1);
    for (const mutation of capture.mutations) {
      const saved = (await read('alice', recordId(mutation.type, mutation.id))).record;
      assert.equal(saved.version, 1);
      assert.equal(saved.originalText, mutation.fields.originalText ?? mutation.fields.title);
    }
    const reused = structuredClone(capture);
    reused.mutations[1].fields.title = 'Different intent';
    await assert.rejects(send(reused), { code: 'operation_reused' });
    assert.equal((await read('alice', 'state')).sequence, 1);
    const fresh = { ...capture, accountId: 'fresh' };
    const firstDeliveries = await Promise.all([send(fresh), send(fresh)]);
    assert.deepEqual(firstDeliveries[0], firstDeliveries[1]);
    assert.equal(firstDeliveries[0].status, 'committed');
    assert.equal((await read('fresh', 'state')).sequence, 1, 'concurrent first deliveries commit only once');
  });

  await check('same-record conflicts retain both proposals and require a new intent', async () => {
    const proposals = ['phone', 'laptop'].map(device => edit(device, 'milk', 1, { description: device }));
    const replies = await Promise.all(proposals.map(send));
    assert.deepEqual(replies.map(r => r.status).sort(), ['committed', 'conflict']);
    const conflict = replies.find(r => r.status === 'conflict');
    const winner = replies.find(r => r.status === 'committed');
    assert.equal(conflict.conflicts[0].current.version, 2);
    assert.notEqual(conflict.proposed[0].fields.description, winner.records[0].description);
    assert.deepEqual(await send(proposals.find(p => p.operationId === conflict.operationId)), conflict);
    assert.deepEqual((await read('alice', `receipt:${conflict.operationId}`)).response, conflict);
    const mixed = edit('mixed-conflict', 'milk', 1, { title: 'Offline milk' });
    mixed.mutations.push(edit('unused', 'bread', 1, { title: 'Offline bread' }).mutations[0]);
    const rejected = await send(mixed);
    assert.equal(rejected.status, 'conflict');
    assert.deepEqual(rejected.proposed, validateOperation(mixed).mutations);
    assert.equal((await record('bread')).version, 1, 'a conflict cannot partially edit a sibling');
    const resolved = await send(edit('resolve', 'milk', 2, { description: 'Reviewed phone and laptop' }));
    assert.equal(resolved.records[0].version, 3);
    assert.equal(resolved.records[0].originalText, capture.mutations[1].fields.originalText);
    const complete = edit('complete', 'milk', 3, { status: 'completed' });
    assert.deepEqual(await send(complete), await send(complete));
    assert.equal((await record('milk')).status, 'completed');
    assert.equal((await record('milk')).version, 4);
  });

  await check('independent writes share an account without losing either edit', async () => {
    const replies = await Promise.all(['bread', 'eggs'].map(id => send(edit('edit-' + id, id, 1, { description: 'Edited ' + id }))));
    assert.ok(replies.every(r => r.status === 'committed'));
    for (const id of ['bread', 'eggs']) {
      assert.equal((await record(id)).version, 2);
      assert.equal((await record(id)).description, 'Edited ' + id);
    }
  });

  await check('account partitions isolate guessed identities and foreign references', async () => {
    for (const id of ['record:item:milk', 'record:list:groceries', `receipt:${capture.operationId}`, 'state']) {
      assert.equal(await read('bob', id), null);
    }
    assert.deepEqual((await changes('bob', 0, 2)).entries, []);
    const foreign = { ...edit('foreign-list', 'new', 0, { title: 'New', listId: 'groceries' }, 'create'), accountId: 'bob' };
    await assert.rejects(send(foreign), { code: 'list_not_found' });
    assert.equal(await read('bob', 'state'), null);
    assert.equal(await read('bob', 'receipt:foreign-list'), null);
    const bob = await send({ ...capture, accountId: 'bob' });
    assert.equal(bob.sequence, 1);
    assert.ok(bob.records.every(r => r.accountId === 'bob'));
    assert.equal((await record('milk')).version, 4);
  });

  await check('tombstones reject stale updates, recreation and edits at the deleted version', async () => {
    const deleted = await send(edit('delete-milk', 'milk', 4, undefined, 'delete'));
    assert.equal(deleted.records[0].deleted, true);
    for (const input of [
      edit('stale', 'milk', 4, { title: 'Offline text' }),
      edit('recreate', 'milk', 0, { title: 'Replacement' }, 'create'),
      edit('edit-deleted', 'milk', 5, { title: 'Deleted version' })
    ]) {
      const conflict = await send(input);
      assert.equal(conflict.status, 'conflict');
      assert.equal(conflict.conflicts[0].current.deleted, true);
      assert.deepEqual(await send(input), conflict);
    }
    assert.equal((await record('milk')).version, 5);
    assert.equal((await record('milk')).deleted, true);
  });

  await check('bounded change pages stay contiguous while new work arrives', async () => {
    const cutoff = (await read('alice', 'state')).sequence;
    const entries = [];
    let after = 0, pages = 0;
    while (true) {
      assert.ok(++pages < 100, 'paging must finish');
      const page = await changes('alice', after, 2);
      assert.ok(page.entries.length <= 2);
      assert.ok(page.nextAfter > after);
      entries.push(...page.entries); after = page.nextAfter;
      if (pages === 1) await send(edit('during-paging', 'arriving', 0, { title: 'Arrived during paging' }, 'create'));
      if (!page.hasMore) break;
    }
    const highWater = (await read('alice', 'state')).sequence;
    assert.equal(highWater, cutoff + 1);
    assert.deepEqual(entries.map(e => e.sequence), Array.from({ length: highWater }, (_, i) => i + 1));
    assert.ok(entries.some(e => e.status === 'conflict'));
    assert.ok(entries.some(e => e.records.some(r => r.deleted)));
    assert.ok(entries.every(e => e.accountId === 'alice'));
    assert.equal((await changes('alice', 0, 50, cutoff)).nextAfter, cutoff);
    assert.deepEqual((await changes('alice', highWater, 2)).entries, []);
    await assert.rejects(changes('alice', highWater + 1, 2), { code: 'cursor_ahead' });
  });

  await check('Cosmos rolls back a failing operation at every position in a seven-write batch', async () => {
    const accountId = 'rollback';
    const duplicate = document(accountId, 'duplicate', { kind: 'probe' });
    await container.items.create(duplicate);
    // Match the size of state + list/three items + receipt + change. A real
    // duplicate create fails on Cosmos itself, without mocking the SDK response.
    for (let failure = 0; failure < 7; failure++) {
      const batch = Array.from({ length: 7 }, (_, index) => ({ operationType: 'Create',
        resourceBody: index === failure ? duplicate : document(accountId, `probe-${failure}-${index}`, { kind: 'probe' }) }));
      const result = await container.items.batch(batch, partition(accountId));
      // Cosmos can return HTTP 207 with the actual conflict in the per-write
      // statuses; the local test store returns the aggregate conflict directly.
      assert.ok([207, 409].includes(result.code));
      assert.equal(result.result.length, 7);
      assert.equal(result.result[failure].statusCode, 409);
      for (const [index, operation] of batch.entries()) {
        if (index === failure) continue;
        assert.equal(result.result[index].statusCode, 424);
        assert.equal(await read(accountId, operation.resourceBody.id), null);
      }
    }
    const retry = { ...capture, accountId };
    const committed = await send(retry);
    assert.equal(committed.status, 'committed');
    assert.equal(committed.sequence, 1);
    assert.equal(committed.records.length, 4);
    assert.deepEqual(await send(retry), committed);
  });
}
