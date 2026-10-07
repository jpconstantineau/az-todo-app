import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documents, startServer } from './harness.mjs';
import { currentCreate } from './current-record.mjs';
import { reflectionId } from '../api/v1/reviews.mjs';
import { deviceExport, readableExport, validateDeviceExport } from '../../html/inbox-export.js';
import { mergeReflectionConflict, reviewReflectionId } from '../../html/reviews.js';

const create = currentCreate;
const prompts = (notes = '') => ({
  mentalSweep: { state: notes ? 'answered' : 'unanswered', notes },
  calendarCheck: { state: 'skipped', notes: '' },
  roleBalance: { state: 'unanswered', notes: '' },
  planReality: { state: 'unanswered', notes: '' }
});
const fields = (reviewId, previousReflectionId, followUpIds = [], notes = '') => ({ reviewId,
  ...(previousReflectionId ? { previousReflectionId } : {}), promptVersion: 1, prompts: prompts(notes), conclusion: notes, followUpIds });
const op = (mutations, accountId = 'alice') => ({ apiVersion: 1, accountId, operationId: crypto.randomUUID(), mutations });
const records = () => Object.fromEntries(documents.filter(doc => doc.kind === 'record').map(doc => [`${doc.record.type}:${doc.record.id}`, structuredClone(doc.record)]));

test('immutable review reflections preserve the frozen review and canonical follow-up identity', async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: () => 'alice' }); t.after(server.close);
  const post = async operation => {
    const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(operation) });
    return { status: response.status, body: await response.json() };
  };
  const commit = async operation => {
    const response = await post(operation);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'committed', JSON.stringify(response.body));
    return response.body;
  };
  await commit(op([create('review', 'root', { reviewKind: 'weekly', reviewDay: '2026-10-07', included: [], decisionHeads: [], decisionCount: 0 })]));
  const firstId = reflectionId('root'), followUpId = 'stable-follow-up';
  const first = op([
    create('reviewReflection', firstId, fields('root', null, [followUpId], 'Call the venue.')),
    create('item', followUpId, { title: 'Call the venue', description: 'Confirm access', originalText: 'Call the venue', status: 'inbox' })
  ]);
  await commit(first);
  let state = records();
  assert.equal(state['review:root'].version, 1);
  assert.deepEqual(state['review:root'].included, []);
  assert.deepEqual(state[`reviewReflection:${firstId}`].followUpIds, [followUpId]);
  assert.equal(state[`item:${followUpId}`].status, 'inbox');

  const collisionOperation = { ...first, operationId: crypto.randomUUID() };
  const collision = await post(collisionOperation);
  assert.equal(collision.status, 409);
  assert.equal(collision.body.status, 'conflict');
  assert.equal(collision.body.conflicts[0].current.id, firstId);
  const recovery = deviceExport('alice', { records: state, queue: [{ operation: collisionOperation, failure: 'Another edit conflicts', receipt: collision.body }],
    draft: { review: { reflection: { rootReviewId: 'root', baseReflectionId: null, prompts: prompts('Pending draft'), conclusion: 'Pending draft', followUp: null } } }, after: 0 }, {});
  assert.deepEqual(validateDeviceExport(recovery).warnings, []);
  assert.match(readableExport(recovery), /Conflict\/receipt[\s\S]*Call the venue/);

  await commit(op([{ type: 'item', id: followUpId, action: 'delete', expectedVersion: 1 }]));
  const secondId = reflectionId('root', firstId);
  await commit(op([create('reviewReflection', secondId, fields('root', firstId, [followUpId], 'Accepted conclusion survives a deleted link.'))]));
  state = records();
  assert.equal(state[`reviewReflection:${secondId}`].previousReflectionId, firstId);
  assert.equal(state[`item:${followUpId}`].deleted, true);

  const exported = deviceExport('alice', { records: state, queue: [], draft: { review: { reflection: { rootReviewId: 'root', baseReflectionId: secondId,
    prompts: prompts('unfinished'), conclusion: 'Unsubmitted conclusion', followUp: { id: 'draft-id', title: 'Draft follow-up', description: '' } } } }, after: 0 }, {});
  assert.deepEqual(validateDeviceExport(exported).warnings, []);
  const readable = readableExport(exported);
  for (const expected of ['Review date: 2026-10-07', 'Mental sweep: answered', 'Accepted conclusion survives', followUpId, 'Previous reflection']) assert.match(readable, new RegExp(expected));
});

test('same-predecessor reflection conflicts merge accepted conclusions and stable follow-ups into the next deterministic revision', async () => {
  const acceptedId = await reviewReflectionId('root');
  const accepted = { type: 'reviewReflection', id: acceptedId, reviewId: 'root', promptVersion: 1, prompts: prompts('Accepted note'),
    conclusion: 'Accepted conclusion', followUpIds: ['accepted-action'], version: 1, deleted: false };
  const pending = { type: 'reviewReflection', id: acceptedId, action: 'create', expectedVersion: 0,
    fields: { ...fields('root', null, ['pending-action'], 'Pending note'), prompts: { ...prompts(), planReality: { state: 'answered', notes: 'Pending note' } }, conclusion: 'Pending conclusion' } };
  const item = create('item', 'pending-action', { title: 'Pending action' });
  const merged = await mergeReflectionConflict({ operation: { mutations: [pending, item] } }, { [`reviewReflection:${acceptedId}`]: accepted });
  assert.equal(merged[0].id, await reviewReflectionId('root', acceptedId));
  assert.equal(merged[0].fields.previousReflectionId, acceptedId);
  assert.deepEqual(merged[0].fields.followUpIds, ['accepted-action', 'pending-action']);
  assert.equal(merged[0].fields.conclusion, 'Accepted conclusion\n\nPending conclusion');
  assert.equal(merged[0].fields.prompts.mentalSweep.notes, 'Accepted note');
  assert.equal(merged[0].fields.prompts.planReality.notes, 'Pending note');
  assert.equal(merged[1].id, 'pending-action');
});

test('reflection trust boundaries reject updates, forged lineage, foreign roots and new cross-workspace links', async t => {
  documents.length = 0;
  let user = 'alice';
  const server = await startServer({ browserUser: () => user }); t.after(server.close);
  const post = async operation => {
    const response = await fetch(`${server.url}/api/v1/operations`, { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify(operation) });
    return { status: response.status, body: await response.json() };
  };
  const commit = async operation => { const response = await post(operation); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  await commit(op([create('review', 'root', { reviewKind: 'weekly', reviewDay: '2026-10-07', included: [], decisionHeads: [], decisionCount: 0 })]));
  await commit(op([create('workspace', 'work', { title: 'Work' }),
    create('review', 'continuation', { reviewKind: 'weekly', reviewDay: '2026-10-07', included: [], decisionHeads: [], decisionCount: 0, previousReviewId: 'root' }),
    create('item', 'work-item', { title: 'Other workspace', workspaceId: 'work' })]));
  const validId = reflectionId('root');
  for (const mutation of [
    { type: 'reviewReflection', id: validId, action: 'update', expectedVersion: 1, fields: fields('root') },
    create('reviewReflection', 'forged-id', fields('root')),
    create('reviewReflection', reflectionId('continuation'), fields('continuation')),
    create('reviewReflection', validId, fields('root', null, ['work-item'])),
    create('reviewReflection', validId, { ...fields('root'), conclusion: 'x'.repeat(4001) }),
    create('reviewReflection', validId, { ...fields('root'), followUpIds: Array.from({ length: 51 }, (_, i) => `f-${i}`) })
  ]) assert.equal((await post(op([mutation]))).status, 400);
  user = 'bob';
  assert.equal((await post(op([create('reviewReflection', validId, fields('root'))], 'bob'))).status, 400);
});
