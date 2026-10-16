import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('production deploys only the tested, current main candidate', async () => {
  const workflow = await read('../../.github/workflows/test.yml');
  assert.match(workflow, /concurrency:\s*[\s\S]*?group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}[\s\S]*?cancel-in-progress: true/);
  assert.match(workflow, /candidate_sha: \$\{\{ steps\.candidate\.outputs\.candidate_sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}[\s\S]*?git rev-parse HEAD[\s\S]*?GITHUB_SHA/);

  const production = workflow.slice(workflow.indexOf('  deploy_production:'));
  assert.match(production, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(production, /needs: test/);
  assert.match(production, /environment:\s*\n\s+name: production/);
  assert.match(production, /ref: \$\{\{ needs\.test\.outputs\.candidate_sha \}\}/);
  assert.match(production, /git rev-parse HEAD[\s\S]*?CANDIDATE_SHA/);
  assert.match(production, /github\.rest\.git\.getRef[\s\S]*?ref: 'heads\/main'[\s\S]*?reference\.object\.sha !== process\.env\.CANDIDATE_SHA/);
  assert.ok(production.indexOf('Ensure candidate is still main') < production.indexOf('Azure/static-web-apps-deploy@v1'));
  assert.match(production, /azure_static_web_apps_api_token: \$\{\{ secrets\.AZURE_STATIC_WEB_APPS_API_TOKEN_AMBITIOUS_SMOKE_020A5481E \}\}/);
  assert.doesNotMatch(production, /repo_token:/);
  assert.match(production, /Test result[\s\S]*?Event SHA[\s\S]*?Tested candidate SHA[\s\S]*?Deployed checkout SHA/);
  assert.match(production, /deployments\/production/);
});

test('preview creation and cleanup are PR-only and least privilege', async () => {
  const workflow = await read('../../.github/workflows/azure-static-web-apps-ambitious-smoke-020a5481e.yml');
  const trigger = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('jobs:'));
  assert.match(trigger, /pull_request:[\s\S]*?opened, synchronize, reopened, closed/);
  assert.doesNotMatch(trigger, /\bpush:/);

  const upload = workflow.slice(workflow.indexOf('  build_and_deploy_job:'), workflow.indexOf('  close_pull_request_job:'));
  assert.match(upload, /github\.event\.action != 'closed'/);
  assert.match(upload, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(upload, /contents: read[\s\S]*?pull-requests: write/);
  assert.match(upload, /repo_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(upload, /production_branch: "main"/);

  const cleanup = workflow.slice(workflow.indexOf('  close_pull_request_job:'));
  assert.match(cleanup, /github\.event\.action == 'closed'/);
  assert.match(cleanup, /contents: none/);
  assert.doesNotMatch(cleanup, /actions\/checkout|repo_token:/);
  assert.match(cleanup, /action: "close"/);
});
