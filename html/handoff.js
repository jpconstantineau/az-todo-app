import { destination, extensionRequest, committedReceipt } from './handoff-protocol.js';

const $ = id => document.getElementById(id);
const status = $('handoffStatus'), error = $('handoffError'), preview = $('handoffPreview'), save = $('handoffSave');
let target, operation, controller, generation = 0, busy = false;
function showStatus(message) {
  error.textContent = ''; error.hidden = true;
  status.textContent = message; status.hidden = false;
}
function showError(message) {
  status.textContent = ''; status.hidden = true;
  error.textContent = message; error.hidden = false;
}
function clear() {
  generation++; controller?.abort(); controller = null; operation = null; busy = false;
  $('handoffCapture').hidden = true;
  for (const id of ['handoffTitle', 'handoffAccount', 'handoffSourceTitle', 'handoffSource']) $(id).textContent = '';
  for (const id of ['handoffDescription', 'handoffOriginal', 'handoffSelection']) $(id).value = '';
  $('handoffSource').removeAttribute('href');
  preview.disabled = !target; save.disabled = false;
}
async function json(url, signal, body) {
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  } catch {
    throw new Error('The server could not be reached. Your saved capture remains in TaskGem. Reopen it there and retry unchanged when online.');
  }
  if ([401, 403].includes(response.status)) {
    $('handoffSignIn').hidden = false;
    throw new Error('Sign in to the capture’s original account, then preview again. Your saved capture remains in TaskGem.');
  }
  if (!response.ok) throw new Error(response.status === 409
    ? 'This capture conflicts with an earlier save. Your saved capture remains in TaskGem. Reopen it there and retry unchanged.'
    : 'The server could not confirm the import. Your saved capture remains in TaskGem. Reopen it there and retry unchanged when online.');
  try { return await response.json(); }
  catch { throw new Error('The server returned an invalid response. Your saved capture remains in TaskGem. Reopen it there and try again.'); }
}
async function account(signal, expected) {
  const session = await json('/api/v1/session', signal);
  if (session.apiVersion !== 1 || typeof session.accountId !== 'string' || !session.accountId || (expected && session.accountId !== expected)) {
    throw new Error('The signed-in account changed. Return to the capture’s original account, then preview again. Your saved capture remains in TaskGem.');
  }
  return session.accountId;
}
async function run(action) {
  if (busy) return;
  busy = true; preview.disabled = save.disabled = true; $('handoffSignIn').hidden = true;
  const current = generation, abort = new AbortController(); controller = abort;
  try { await action(abort.signal, () => current === generation); }
  catch (failure) {
    if (current !== generation) return;
    clear(); showError(failure.message || 'The import failed. Your saved capture remains in TaskGem. Reopen it there and try again.');
    ($('handoffSignIn').hidden ? preview : $('handoffSignIn')).focus();
  } finally {
    if (current === generation) { busy = false; controller = null; preview.disabled = !target; save.disabled = false; }
  }
}
try {
  if (location.search || window.top !== window || !isSecureContext) throw new Error('Open this import directly from TaskGem in a secure browser tab.');
  target = destination(location.hash);
  $('handoffSignIn').href = '/.auth/login/github?post_login_redirect_uri=' + encodeURIComponent('/handoff.html' + location.hash);
  preview.disabled = false; showStatus('Ready to preview this saved capture.');
} catch (failure) { preview.hidden = true; showError(failure.message); }

preview.onclick = () => {
  if (busy || !target) return;
  clear();
  void run(async (signal, current) => {
    showStatus('Checking your account and saved capture…');
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
    showStatus('Review the saved capture. Nothing has been imported yet.');
  });
};
save.onclick = () => {
  if (!operation || busy) return;
  const pending = operation;
  void run(async (signal, current) => {
    showStatus('Saving to your inbox…');
    await account(signal, pending.accountId);
    const receipt = committedReceipt(await json('/api/v1/operations', signal, pending), pending);
    await account(signal, pending.accountId);
    if (!current()) return;
    showStatus('Saved. Confirming TaskGem can remove its copy…');
    await extensionRequest(target, 'acknowledge', pending.accountId, receipt, signal);
    if (!current()) return;
    clear(); preview.disabled = true;
    showStatus('Imported. Open the workspace and sync to see your capture.');
    $('handoff').focus();
  });
};
$('handoffCancel').onclick = () => { clear(); showStatus('Import cancelled. The saved capture remains in TaskGem unless a save had already completed.'); preview.focus(); };
// No preview survives leaving this page or returning from another account/tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clear(); showStatus('Preview again to verify your account. The saved capture remains in TaskGem until the import is confirmed.'); }
});
addEventListener('pagehide', clear);
addEventListener('hashchange', () => { target = null; clear(); $('handoffSignIn').hidden = true; preview.hidden = true; showError('Reopen this import from TaskGem.'); });
