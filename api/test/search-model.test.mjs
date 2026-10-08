import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionPaths, normalizeSearchText, searchWorkspace } from '../../html/search-model.js';

const ref = (type, id) => ({ type, id });
const records = {
  'list:active': { type: 'list', id: 'active', title: 'Client work', kind: 'area', workspaceId: 'personal', archived: false },
  'list:archive': { type: 'list', id: 'archive', title: 'Old plans', kind: 'list', workspaceId: 'personal', archived: true },
  'project:unicode': { type: 'project', id: 'unicode', title: 'Cafe\u0301 🚀', description: 'Launch <b>literally</b>', originalText: 'EXACT  source\n', outcome: 'Résumé delivered', status: 'active', workspaceId: 'personal', parentRef: ref('list', 'active') },
  'item:mixed': { type: 'item', id: 'mixed', title: 'Duplicate route', description: 'x'.repeat(4000), originalText: '  Keep exact whitespace\n', status: 'next', workspaceId: 'personal', collectionRefs: [ref('list', 'active'), ref('list', 'archive')] },
  'item:complete': { type: 'item', id: 'complete', title: 'Closed result', status: 'completed', workspaceId: 'personal', collectionRefs: [] },
  'item:someday': { type: 'item', id: 'someday', title: 'Later result', status: 'someday', workspaceId: 'personal', collectionRefs: [] },
  'list:reference': { type: 'list', id: 'reference', title: 'Source shelf', kind: 'reference', workspaceId: 'personal', archived: false },
  'item:deleted': { type: 'item', id: 'deleted', title: 'Deleted result', status: 'next', workspaceId: 'personal', deleted: true, collectionRefs: [] },
};

test('search model normalizes Unicode without rewriting source and searches every specified field', () => {
  assert.equal(normalizeSearchText('CAFÉ'), normalizeSearchText('Cafe\u0301'));
  for (const query of ['café', '🚀', '<B>LITERALLY</B>', 'résumé', 'exact  source']) {
    assert.deepEqual(searchWorkspace(records, { query, resultType: 'all', resultState: 'all' }).map(record => record.id), ['unicode'], query);
  }
  assert.deepEqual(searchWorkspace(records, { query: 'client work', resultType: 'all', resultState: 'all' }).map(record => record.id), ['unicode', 'active', 'mixed']);
  assert.equal(records['project:unicode'].originalText, 'EXACT  source\n');
  assert.deepEqual(collectionPaths(records['project:unicode'], records), ['Client work']);
  assert.deepEqual(searchWorkspace(records, { query: 'xxxx', resultType: 'item', resultState: 'active' }).map(record => record.id), ['mixed']);
});

test('search model exposes recovery states, types and multi-membership once', () => {
  assert.deepEqual(searchWorkspace(records, { query: '', resultType: 'all', resultState: 'active' }).map(record => record.id), ['unicode', 'active', 'mixed']);
  assert.deepEqual(searchWorkspace(records, { query: '', resultType: 'all', resultState: 'archived' }).map(record => record.id), ['mixed', 'archive']);
  assert.deepEqual(searchWorkspace(records, { query: 'duplicate', resultType: 'all', resultState: 'all' }).map(record => record.id), ['mixed']);
  assert.deepEqual(searchWorkspace(records, { query: '', resultType: 'item', resultState: 'status:completed' }).map(record => record.id), ['complete']);
  assert.deepEqual(searchWorkspace(records, { query: '', resultType: 'all', resultState: 'status:reference' }).map(record => record.id), ['reference']);
  assert.deepEqual(searchWorkspace(records, { query: '', resultType: 'item', resultState: 'status:someday' }).map(record => record.id), ['someday']);
  assert.ok(!searchWorkspace(records, { query: 'deleted', resultType: 'all', resultState: 'all' }).length);
});
