// A deliberately narrow protocol: one immutable inbox capture per explicit handoff.
export const protocol = 'taskgem-handoff-v1';
const fail = () => { throw new Error('Invalid TaskGem capture. Keep it in the extension and check its format.'); };
function object(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) fail();
}
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(); }

export function destination(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const extensionId = params.get('extension'), ticket = params.get('ticket');
  if ([...params].length !== 2 || !/^[a-p]{32}$/.test(extensionId || '') || !/^[a-f0-9]{32}$/.test(ticket || '')) {
    throw new Error('Open a fresh handoff from TaskGem. The link must contain only its extension ID and a one-use handoff ticket.');
  }
  return { extensionId, ticket };
}

export function captureOperation(value, accountId) {
  object(value, ['apiVersion', 'accountId', 'operationId', 'mutations']);
  if (value.apiVersion !== 1 || value.accountId !== accountId || typeof accountId !== 'string' || !accountId) fail();
  id(value.operationId);
  if (!Array.isArray(value.mutations) || value.mutations.length !== 1) fail();
  const mutation = value.mutations[0];
  object(mutation, ['type', 'id', 'action', 'expectedVersion', 'fields']);
  if (mutation.type !== 'item' || mutation.action !== 'create' || mutation.expectedVersion !== 0) fail();
  id(mutation.id);
  const fields = mutation.fields;
  object(fields, ['title', 'description', 'originalText', 'sourceTitle', 'sourceUrl', 'selectedText']);
  text(fields.title, 200, true); text(fields.description, 4000); text(fields.originalText, 16000, true);
  text(fields.sourceTitle, 2000); text(fields.selectedText, 8000); text(fields.sourceUrl, 2048, true);
  try {
    const url = new URL(fields.sourceUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail();
  } catch { fail(); }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536) fail();
  return structuredClone(value);
}

export function committedReceipt(receipt, operation) {
  const mutation = operation.mutations[0], record = receipt?.records?.[0];
  if (receipt?.apiVersion !== 1 || receipt.accountId !== operation.accountId || receipt.operationId !== operation.operationId ||
      receipt.status !== 'committed' || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 ||
      !Array.isArray(receipt.records) || receipt.records.length !== 1 || record?.accountId !== operation.accountId ||
      record.type !== 'item' || record.id !== mutation.id || record.version !== 1 || record.deleted !== false ||
      Object.entries(mutation.fields).some(([key, value]) => record[key] !== value)) {
    throw new Error('The server has not confirmed this exact capture. Keep the extension copy and retry unchanged.');
  }
  // Only this capture's identity is returned to the extension, never other account data.
  return { apiVersion: 1, accountId: receipt.accountId, operationId: receipt.operationId,
    status: 'committed', sequence: receipt.sequence, itemId: record.id, version: record.version };
}

export function extensionRequest(target, type, accountId, receipt, signal) {
  return new Promise((resolve, reject) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) { reject(new Error('TaskGem messaging is unavailable. Open this handoff in the browser where the extension is installed.')); return; }
    const requestId = crypto.randomUUID();
    const message = { protocol, type, ticket: target.ticket, requestId, accountId, ...(receipt ? { receipt } : {}) };
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error('Import cancelled. The extension must keep any unacknowledged capture.'));
    const timer = setTimeout(() => finish(new Error('TaskGem did not acknowledge the request. Keep the capture and retry from the extension.')), 15000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      // Runtime binds this callback to this extension/request; no window-message listener.
      runtime.sendMessage(target.extensionId, message, response => {
        const error = runtime.lastError;
        if (error) { finish(new Error('TaskGem could not be reached. Keep the capture and reopen its handoff.')); return; }
        try {
          object(response, ['protocol', 'type', 'ticket', 'requestId', 'accountId', type === 'preview' ? 'operation' : 'acknowledged']);
          if (response.protocol !== protocol || response.type !== type || response.ticket !== target.ticket || response.requestId !== requestId || response.accountId !== accountId) fail();
          if (type === 'preview') finish(null, captureOperation(response.operation, accountId));
          else if (response.acknowledged === true) finish(null, true);
          else fail();
        } catch (error) { finish(error); }
      });
    } catch { finish(new Error('TaskGem messaging failed. Keep the capture and retry from the extension.')); }
  });
}
