// Device model status is shared by capture, clarification and the header.
export const modelOptions = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
export function destroyModel(model) { try { model?.destroy(); } catch { /* Aborted sessions may already be destroyed. */ } }
let readiness = 'unavailable', failed = false, checking = true, revision = 0, render = () => {};
const work = new Set();
export const modelReadiness = () => readiness;

export async function checkModel() {
  const current = ++revision;
  try {
    const api = globalThis.LanguageModel;
    const result = api?.availability && api?.create ? await api.availability(modelOptions) : 'unavailable';
    const value = ['available', 'downloadable', 'downloading'].includes(result) ? result : 'unavailable';
    if (current === revision && !work.size) { readiness = value; failed = false; checking = false; render(); }
    return value;
  } catch (error) {
    if (current === revision && !work.size) { failed = true; checking = false; render(); }
    throw error;
  }
}

export function beginModelWork() {
  const operation = {};
  work.add(operation); revision++; failed = false; checking = false; render();
  // Idempotent completion lets cancellation release a job before its promise settles.
  return result => {
    if (!work.delete(operation)) return;
    revision++;
    if (result === 'available') readiness = 'available';
    if (result === 'error') failed = true;
    render();
  };
}

export function setupAgentStatus() {
  const button = document.getElementById('agentStatus'), label = document.getElementById('agentLabel');
  let controller, finish;
  render = () => {
    const state = work.size || checking ? 'busy' : failed ? 'error' : readiness === 'downloading' ? 'busy' : readiness;
    const message = {
      available: 'AI agent is ready on this device.',
      busy: checking ? 'Checking AI agent availability.' : work.size ? 'AI agent is busy preparing the model or generating suggestions.' : 'AI agent model is downloading. Press to continue preparing it.',
      error: 'AI agent encountered an error. Press to retry preparing the model.',
      downloadable: 'AI agent needs a model download. Press to download and prepare it.',
      unavailable: 'AI agent is unavailable on this device or browser.'
    }[state];
    button.dataset.state = state; button.title = message; button.setAttribute('aria-label', message);
    button.setAttribute('aria-disabled', String(!!work.size || checking || state === 'unavailable'));
    label.textContent = message;
  };
  render();
  button.onclick = async () => {
    if (button.getAttribute('aria-disabled') === 'true' || readiness === 'available' && !failed) return;
    controller = new AbortController(); const signal = controller.signal;
    const done = beginModelWork(); finish = done;
    let model;
    try {
      // Start in this click to retain the activation required for downloads.
      model = await globalThis.LanguageModel.create({ ...modelOptions, signal, monitor() {} });
      if (!signal.aborted) done('available');
    } catch { if (!signal.aborted) done('error'); }
    finally { destroyModel(model); done(); if (finish === done) { finish = null; controller = null; } }
  };
  addEventListener('pagehide', () => { controller?.abort(); finish?.(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !work.size) void checkModel().catch(() => {}); });
  void checkModel().catch(() => {});
}
