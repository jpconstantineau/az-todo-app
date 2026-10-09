import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { documents, routes, startServer } from './harness.mjs';
import { fieldsFor } from '../api/v1/contract.mjs';

const retiredRoutes = {
  GET: ['app', 'lists/all', 'lists/editDefaults', 'lists/quickAddForm', 'lists/defaultOptions',
    'items/byList', 'items/filterByStatus', 'settings/edit'],
  POST: ['lists/create', 'lists/updateDefaults', 'lists/resetDefaults', 'items/create',
    'items/toggleComplete', 'settings/ensure', 'settings/update', 'settings/reset']
};

test('v1 gating stays explicit and retired paths use the normal not-found response', async t => {
  const server = await startServer({ browserUser: true }); t.after(server.close);
  const api = process.env.V1_API_ENABLED;
  const before = structuredClone(documents);
  try {
    for (const enabled of ['true', 'false', undefined]) {
      if (enabled === undefined) delete process.env.V1_API_ENABLED; else process.env.V1_API_ENABLED = enabled;
      const response = await fetch(server.url + '/api/v1/session');
      assert.equal(response.status, enabled === 'true' ? 200 : 503);
      for (const [method, paths] of Object.entries(retiredRoutes)) {
        for (const path of paths) {
          const response = await fetch(`${server.url}/api/${path}`, { method });
          assert.equal(response.status, 404, `${method} ${path}`);
          assert.equal(await response.text(), 'Not found');
        }
      }
    }
    assert.deepEqual(documents, before);
  } finally {
    if (api === undefined) delete process.env.V1_API_ENABLED; else process.env.V1_API_ENABLED = api;
  }
});

test('canonical shell uses local assets, safe routing and no fragment runtime', async () => {
  const root = new URL('../../html/', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /src="\/pwa.js\?v=27"/);
  assert.match(html, /type="module" src="\/inbox.js\?v=29"/);
  assert.match(await readFile(new URL('shared.html', root), 'utf8'), /type="module" src="\/shared.js\?v=27"/);
  assert.equal(new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])).size, [...html.matchAll(/\bid="([^"]+)"/g)].length);
  await assert.rejects(readFile(new URL('inbox.html', root), 'utf8'), { code: 'ENOENT' });
  for (const path of await readdir(root)) {
    if (!/\.(html|js)$/.test(path)) continue;
    assert.doesNotMatch(await readFile(new URL(path, root), 'utf8'), /htmx|\bhx-[a-z]|cdn\.jsdelivr|HX-Redirect/);
  }
  const config = JSON.parse(await readFile(new URL('staticwebapp.config.json', root), 'utf8'));
  assert.ok(config.navigationFallback.exclude.includes('/api/*'));
  assert.ok(config.navigationFallback.exclude.includes('/.auth/*'));
  assert.deepEqual(config.routes, [{ route: '/api/*', allowedRoles: ['authenticated'] }]);
  assert.doesNotMatch(config.globalHeaders['content-security-policy'], /unsafe-inline|jsdelivr/);
  assert.deepEqual([...routes.keys()].filter(key => key.startsWith('POST /api/v1/')), ['POST /api/v1/operations']);
});

test('current create contract requires canonical workspace, membership and project lifecycle fields', () => {
  assert.throws(() => fieldsFor('item', 'create', { title: 'Task', collectionRefs: [] }), /workspaceId/);
  assert.throws(() => fieldsFor('item', 'create', { title: 'Task', workspaceId: 'personal' }), /collectionRefs/);
  assert.throws(() => fieldsFor('list', 'create', { title: 'List' }), /workspaceId/);
  assert.throws(() => fieldsFor('project', 'create', { title: 'Project', outcome: 'Done', workspaceId: 'personal' }), /status/);
  assert.equal(fieldsFor('list', 'create', { title: 'List', workspaceId: 'personal' }).archived, false);
  assert.equal(fieldsFor('project', 'create', { title: 'Project', outcome: 'Done', status: 'active', workspaceId: 'personal' }).archived, false);
  assert.deepEqual(fieldsFor('list', 'update', { archived: true }), { archived: true });
  assert.throws(() => fieldsFor('project', 'update', { archived: 'yes' }), /true or false/);
  assert.throws(() => fieldsFor('review', 'create', { reviewKind: 'weekly', reviewDay: '2026-10-05', included: [], decisionHeads: [], decisionCount: 0 }), /workspaceId/);
  assert.deepEqual(fieldsFor('item', 'create', { title: 'Task', workspaceId: 'personal', collectionRefs: [] }).collectionRefs, []);
  assert.equal(fieldsFor('item', 'create', { title: 'Task', workspaceId: 'personal', collectionRefs: [] }).plannedWeek, null);
  assert.equal(fieldsFor('item', 'update', { plannedWeek: '2026-10-05' }).plannedWeek, '2026-10-05');
  assert.equal(fieldsFor('item', 'update', { plannedWeek: null }).plannedWeek, null);
  assert.throws(() => fieldsFor('item', 'update', { plannedWeek: '2026-10-5' }), /plannedWeek/);
  assert.deepEqual(fieldsFor('item', 'update', { effortEstimate: { scale: 'tshirt', value: 'L' } }).effortEstimate, { scale: 'tshirt', value: 'L' });
  assert.deepEqual(fieldsFor('item', 'update', { effortEstimate: { scale: 'fibonacci', value: 13 } }).effortEstimate, { scale: 'fibonacci', value: 13 });
  assert.throws(() => fieldsFor('item', 'update', { effortEstimate: { scale: 'minutes', value: 30 } }), /tagged T-shirt or Fibonacci/);
  assert.deepEqual(fieldsFor('planPreference', 'create', { workspaceId: 'personal', estimationMethod: 'none' }), { workspaceId: 'personal', estimationMethod: 'none' });
  assert.throws(() => fieldsFor('planPreference', 'create', { workspaceId: 'personal', estimationMethod: 'hours' }), /None, T-shirt or Fibonacci/);
  const plan = fieldsFor('dailyPlan', 'create', { workspaceId: 'personal', planDay: '2026-10-07', actionIds: ['one'], loadAssessment: 'full', carryoverDecisions: [], revisionHead: 'revision', revisionCount: 1 });
  assert.deepEqual(plan.actionIds, ['one']);
  assert.throws(() => fieldsFor('dailyPlan', 'create', { ...plan, actionIds: ['one', 'one'] }), /unique/);
  assert.throws(() => fieldsFor('dailyPlanRevision', 'update', {}), /immutable/);
  const view = fieldsFor('savedView', 'create', { title: 'Completed reports', workspaceId: 'personal', query: 'report', resultType: 'item', resultState: 'status:completed' });
  assert.deepEqual(view, { title: 'Completed reports', workspaceId: 'personal', query: 'report', resultType: 'item', resultState: 'status:completed' });
  for (const fields of [{ title: ' ' }, { query: 'x'.repeat(201) }, { resultType: 'task' }, { resultState: 'status:in\nvalid' }]) {
    assert.throws(() => fieldsFor('savedView', 'create', { ...view, ...fields }));
  }
});
