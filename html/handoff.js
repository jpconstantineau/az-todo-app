import { destination, extensionRequest, committedReceipt } from './handoff-protocol.js';

const $ = id => document.getElementById(id);
const status = $('handoffStatus'), error = $('handoffError'), preview = $('handoffPreview'), save = $('handoffSave');
let target, operation, controller, generation = 0, busy = false;
function clear() {
  generation++; controller?.abort(); controller = null; operation = null; busy = false;
  $('handoffCapture').hidden = true;
  for (const id of ['handoffTitle', 'handoffAccount', 'handoffSourceTitle', 'handoffSource']) $(id).textContent = '';
  for (const id of ['handoffDescription', 'handoffOriginal', 'handoffSelection']) $(id).value = '';
  $('handoffSource').removeAttribute('href');
  preview.disabled = !target; save.disabled = false;
}
async function json(url, signal, body) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if ([401, 403].includes(response.status)) {
    $('handoffSignIn').hidden = false;
    throw new Error('Sign in to the capture’s original account, then preview again. The extension copy is retained.');
  }
  if (!response.ok) throw new Error(response.status === 409
    ? 'The account, capture identity or content conflicts with an earlier save. Keep the extension copy; do not generate a new ID to retry.'
    : 'The server could not confirm the request. Keep the extension copy and retry unchanged when online.');
  return response.json();
}
async function account(signal, expected) {
  const session = await json('/api/v1/session', signal);
  if (session.apiVersion !== 1 || typeof session.accountId !== 'string' || !session.accountId || (expected && session.accountId !== expected)) {
    throw new Error('The signed-in account changed. Return to the original account and preview again.');
  }
  return session.accountId;
}
async function run(action) {
  if (busy) return;
  busy = true; preview.disabled = save.disabled = true; error.hidden = true; $('handoffSignIn').hidden = true;
  const current = generation, abort = new AbortController(); controller = abort;
  try { await action(abort.signal, () => current === generation); }
  catch (failure) {
    if (current !== generation) return;
    clear(); error.textContent = failure.message || 'Import failed. Keep the capture in TaskGem and retry.'; error.hidden = false;
    status.textContent = 'Import paused. Preview again to retry the same saved capture.';
    preview.focus();
  } finally {
    if (current === generation) { busy = false; controller = null; preview.disabled = !target; save.disabled = false; }
  }
}
try {
  if (location.search || window.top !== window || !isSecureContext) throw new Error('Open the TaskGem handoff directly on this site over HTTPS.');
  target = destination(location.hash);
  $('handoffExtension').textContent = 'Connect to installed extension: ' + target.extensionId;
  $('handoffSignIn').href = '/.auth/login/github?post_login_redirect_uri=' + encodeURIComponent('/handoff.html' + location.hash);
  preview.disabled = false;
} catch (failure) { error.textContent = failure.message; error.hidden = false; }

preview.onclick = () => {
  if (busy || !target) return;
  clear();
  void run(async (signal, current) => {
    status.textContent = 'Checking your account and saved capture…';
    const accountId = await account(signal);
    const incoming = await extensionRequest(target, 'preview', accountId, null, signal);
    await account(signal, accountId);
    let label = 'Your signed-in account';
    try {
      const profile = await json('/.auth/me', signal);
      if (profile.clientPrincipal?.userId === accountId && typeof profile.clientPrincipal.userDetails === 'string' && profile.clientPrincipal.userDetails.trim()) label = profile.clientPrincipal.userDetails;
    } catch { /* A friendly name is optional; verified account ownership is not. */ }
    if (!current()) return;
    operation = incoming;
    const fields = operation.mutations[0].fields;
    $('handoffTitle').textContent = fields.title;
    $('handoffAccount').textContent = 'Destination: ' + label;
    $('handoffDescription').value = fields.description; $('handoffOriginal').value = fields.originalText; $('handoffSelection').value = fields.selectedText;
    $('handoffSourceTitle').textContent = fields.sourceTitle;
    $('handoffSource').textContent = fields.sourceUrl; $('handoffSource').href = fields.sourceUrl;
    $('handoffCapture').hidden = false; $('handoffTitle').focus();
    status.textContent = 'Review the saved capture. Nothing has been imported yet.';
  });
};
save.onclick = () => {
  if (!operation || busy) return;
  const pending = operation;
  void run(async (signal, current) => {
    status.textContent = 'Saving to your inbox…';
    await account(signal, pending.accountId);
    const receipt = committedReceipt(await json('/api/v1/operations', signal, pending), pending);
    await account(signal, pending.accountId);
    if (!current()) return;
    status.textContent = 'Server-confirmed. Acknowledging the saved capture to TaskGem…';
    await extensionRequest(target, 'acknowledge', pending.accountId, receipt, signal);
    if (!current()) return;
    clear(); preview.disabled = true;
    status.textContent = 'Imported and acknowledged. Open the workspace and sync to see your capture.';
    $('handoff').focus();
  });
};
$('handoffCancel').onclick = () => { clear(); status.textContent = 'Import cancelled. Any unacknowledged capture stays in TaskGem; a save already sent may have committed.'; preview.focus(); };
// No preview survives leaving this page or returning from another account/tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clear(); status.textContent = 'Preview again to verify your account. Unacknowledged captures stay in TaskGem.'; }
});
addEventListener('pagehide', clear);
addEventListener('hashchange', () => { target = null; clear(); error.textContent = 'The handoff link changed. Reopen it from TaskGem.'; error.hidden = false; });
