const request = async (path, options = {}) => {
  const response = await fetch(`/api/v1/ai/${path}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options });
  let body = {};
  try { body = await response.json(); } catch { /* A bounded generic error is shown below. */ }
  if (!response.ok) throw Object.assign(new Error(body.message || 'Cloud AI is unavailable. Your text is kept.'), { status: response.status });
  if (body.apiVersion !== 1) throw new Error('Cloud AI returned an unexpected response. Your text is kept.');
  return body;
};

export async function cloudStatus(signal = AbortSignal.timeout(15000)) {
  const body = await request('status', { signal });
  return body.configured === true && typeof body.provider === 'string' && typeof body.model === 'string'
    ? { available: true, label: `${body.provider} · ${body.model}` } : { available: false, label: '' };
}

export async function cloudSuggestion(kind, prompt, signal) {
  const body = await request('suggestions', { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, prompt }) });
  if (typeof body.suggestion !== 'string') throw new Error('Cloud AI returned an invalid suggestion. Your text is kept.');
  return body.suggestion;
}
