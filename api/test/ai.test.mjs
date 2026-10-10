import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { principal, startServer } from './harness.mjs';
const { configuration, requestSuggestion } = await import('../api/v1/ai.mjs');

const capture = JSON.stringify({ items: [{ title: 'Call Sam', description: '', listId: '', priority: '', context: '', dueDate: '', dueTime: '', evidence: 'Call Sam', uncertainty: '' }], notes: '' });
const configured = { url: 'https://provider.example/v1/chat/completions', key: 'super-secret-key', model: 'vendor/model', provider: 'provider.example' };

test('AI configuration is all-or-nothing and exposes only safe labels', () => {
  assert.equal(configuration({}), null);
  assert.equal(configuration({ AI_API_URL: configured.url, AI_API_KEY: configured.key }), null);
  assert.equal(configuration({ AI_API_URL: 'http://provider.example/v1/chat', AI_API_KEY: configured.key, AI_MODEL: configured.model }), null);
  assert.equal(configuration({ AI_API_URL: 'https://user:pass@provider.example/v1/chat', AI_API_KEY: configured.key, AI_MODEL: configured.model }), null);
  assert.equal(configuration({ AI_API_URL: configured.url + '#secret', AI_API_KEY: configured.key, AI_MODEL: configured.model }), null);
  assert.equal(configuration({ AI_API_URL: configured.url, AI_API_KEY: configured.key, AI_MODEL: 'bad model\nname' }), null);
  assert.deepEqual(configuration({ AI_API_URL: configured.url, AI_API_KEY: configured.key, AI_MODEL: configured.model }), configured);
  assert.equal(configuration({ AI_API_URL: 'http://127.0.0.1:8080/chat', AI_API_KEY: configured.key, AI_MODEL: configured.model })?.provider, '127.0.0.1');
});

test('provider request uses one bounded structured call and maps failures without leaking secrets', async () => {
  let calls = 0;
  const success = await requestSuggestion(configured, 'clarification', 'private task text', async (url, options) => {
    calls++;
    assert.equal(url, configured.url);
    assert.equal(options.headers.authorization, `Bearer ${configured.key}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, configured.model);
    assert.equal(body.messages[0].content, 'private task text');
    assert.equal(body.response_format.json_schema.strict, true);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"Call Sam"}' } }] }));
  });
  assert.deepEqual(success, { suggestion: '{"text":"Call Sam"}' });
  assert.equal(calls, 1, 'provider calls are never retried');
  for (const status of [429, 500]) {
    const result = await requestSuggestion(configured, 'clarification', 'private', async () => new Response('provider details', { status }));
    assert.equal(result.status, status === 429 ? 429 : 502);
    assert.doesNotMatch(JSON.stringify(result), /super-secret|provider details|provider\.example/);
  }
  for (const content of ['not json', '{"text":"ok","status":"done"}', '{"items":[]}']) {
    const result = await requestSuggestion(configured, 'clarification', 'private', async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })));
    assert.equal(result.error, 'ai_invalid_response');
  }
  const oversize = await requestSuggestion(configured, 'clarification', 'private', async () => new Response('x'.repeat(65537)));
  assert.equal(oversize.error, 'ai_invalid_response');
  const timeout = await requestSuggestion(configured, 'clarification', 'private', (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('secret', 'AbortError')));
  }), 5);
  assert.equal(timeout.error, 'ai_timeout');
});

test('authenticated AI routes enforce origin and bounds before one provider call', async t => {
  let calls = 0, providerBody;
  const provider = createServer(async (req, res) => {
    calls++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    providerBody = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: capture } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const previous = { url: process.env.AI_API_URL, key: process.env.AI_API_KEY, model: process.env.AI_MODEL };
  process.env.AI_API_URL = `http://127.0.0.1:${provider.address().port}/chat/completions`;
  process.env.AI_API_KEY = 'route-secret'; process.env.AI_MODEL = 'route/model';
  t.after(() => {
    for (const [name, value] of Object.entries({ AI_API_URL: previous.url, AI_API_KEY: previous.key, AI_MODEL: previous.model })) value === undefined ? delete process.env[name] : process.env[name] = value;
  });
  const api = await startServer(); t.after(api.close);
  const auth = { 'x-ms-client-principal': principal };
  const status = await fetch(api.url + '/api/v1/ai/status', { headers: auth });
  assert.deepEqual(await status.json(), { apiVersion: 1, configured: true, provider: '127.0.0.1', model: 'route/model' });
  const valid = { kind: 'capture-extraction', prompt: 'Extract this: Call Sam' };
  for (const headers of [{ origin: api.url }, { origin: api.url, ...auth }]) {
    const response = await fetch(api.url + '/api/v1/ai/suggestions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(valid) });
    assert.equal(response.status, headers['x-ms-client-principal'] ? 200 : 401);
  }
  assert.equal(calls, 1);
  assert.equal(providerBody.model, 'route/model');
  assert.equal(providerBody.messages[0].content, valid.prompt);
  assert.ok(!JSON.stringify(providerBody).includes('route-secret'));
  for (const attempt of [
    { headers: { ...auth, origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify(valid), status: 403 },
    { headers: { ...auth, origin: api.url, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'pause-autocomplete', prompt: 'x' }), status: 400 },
    { headers: { ...auth, origin: api.url, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clarification', prompt: 'x'.repeat(24001) }), status: 400 },
    { headers: { ...auth, origin: api.url, 'content-type': 'application/json' }, body: 'x'.repeat(32769), status: 413 },
    { headers: { ...auth, origin: api.url, 'content-type': 'text/plain' }, body: '{}', status: 415 }
  ]) {
    const response = await fetch(api.url + '/api/v1/ai/suggestions', { method: 'POST', headers: attempt.headers, body: attempt.body });
    assert.equal(response.status, attempt.status);
  }
  assert.equal(calls, 1, 'invalid auth, origin, kind and input never reach the provider');
});
