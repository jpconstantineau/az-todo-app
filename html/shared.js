import { transact } from './inbox-store.js?v=15';

const $ = id => document.getElementById(id);
const rights = ['view', 'add', 'edit', 'complete', 'delete'];
const fresh = () => ({ lists: {}, directory: [], drafts: {}, selected: '', pending: null });
let accountId, state = fresh(), generation = 0, syncing = false, working = false, cursor, editItem, editorOpener;
let invitation, pendingFocus;
const message = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
async function offlineReady() {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return;
  const channel = new MessageChannel();
  channel.port1.onmessage = event => {
    channel.port1.close();
    message('sharedOffline', event.data === 'todo-inbox-shell-v35' ? 'Ready to reopen shared lists offline.' : 'An app update is needed for offline reopening. Save your work, close all app tabs and reopen online.');
  };
  worker.postMessage('shell-version', [channel.port2]);
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', offlineReady);
  void navigator.serviceWorker.register('/inbox-sw.js', { updateViaCache: 'none' }).then(offlineReady)
    .catch(() => message('sharedOffline', 'Offline setup could not finish. Keep this page open or reopen online.'));
} else message('sharedOffline', 'This browser cannot reopen shared lists offline. Keep this page open while offline.');
const current = () => state.lists[state.selected];
const can = permission => !working && !syncing && !state.pending && !current()?.deleted && current()?.permissions.includes(permission);
function clearAccount() {
  generation++; accountId = null; state = fresh(); invitation = null; editItem = null; editorOpener = null; pendingFocus = null;
  $('sharedMain').hidden = true; $('sharedEditor').close(); $('sharedItems').replaceChildren(); $('sharedDeleted').replaceChildren();
  $('sharedMembers').replaceChildren(); $('sharedInvitations').replaceChildren(); $('sharedSelect').replaceChildren();
  $('sharedTitle').textContent = ''; $('sharedAccess').textContent = ''; $('pendingText').textContent = '';
  $('invitationLink').value = ''; $('invitationResult').hidden = true;
  for (const id of ['createShared', 'joinShared', 'addShared', 'editShared', 'renameShared']) $(id).reset();
}
async function local(update) {
  const owner = accountId, epoch = generation;
  if (!owner) throw new Error('Sign in to save this action.');
  const saved = await transact(owner, update ? data => { data.sharedLists ??= fresh(); update(data.sharedLists); } : undefined);
  if (owner !== accountId || epoch !== generation) throw new Error('Account changed. The action stays with its original account.');
  state = saved.sharedLists ?? fresh();
  return state;
}
async function request(path, body) {
  const owner = accountId, epoch = generation;
  const response = await fetch('/api/' + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  let value; try { value = await response.json(); } catch { value = {}; }
  if (owner !== accountId || epoch !== generation) throw new Error('Account changed while the request was running.');
  if (response.status === 401 || value.error === 'account_mismatch' || value.accountId && owner && value.accountId !== owner) {
    clearAccount(); $('sharedSignIn').hidden = false;
    try { await transact(null, saved => { saved.paused = true; }); }
    catch { throw new Error('Could not record the account pause on this device. Keep this browser profile private; its offline copy may still be available.'); }
    channel.postMessage('changed');
    throw new Error('Sign in to the original account to resume. Its pending work stays on this device.');
  }
  if (!response.ok) throw Object.assign(new Error(value.message || 'Could not reach shared lists. Pending work is kept.'), { status: response.status, code: value.error });
  if (value.apiVersion !== 1 || typeof value.accountId !== 'string') throw new Error('Unexpected response. Pending work is kept.');
  return value;
}
async function verify() {
  const session = await request('v1/session');
  if (!accountId) {
    accountId = session.accountId; await local();
    await transact(null, saved => { saved.accountId = accountId; saved.paused = false; });
    channel.postMessage('changed');
  }
  $('sharedSignIn').hidden = true; $('sharedMain').hidden = false;
}
function button(label, action, disabled = false) {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.disabled = disabled;
  element.onclick = () => void run(action); return element;
}
function permissionControls(container, values) {
  container.replaceChildren();
  const legend = document.createElement('legend'); legend.textContent = 'Permissions'; container.append(legend);
  for (const right of rights) {
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = right;
    input.checked = values.includes(right); input.disabled = right === 'view'; label.append(input, right); container.append(label);
  }
}
const selectedRights = container => [...container.querySelectorAll('input:checked')].map(input => input.value);
permissionControls($('invitePermissions'), ['view', 'add', 'complete']);
function restoreInputs() {
  $('addShared').elements.title.value = state.drafts[state.selected]?.add || '';
  $('createShared').elements.title.value = state.createTitle || '';
}
function itemFocus(element) {
  const row = element.closest('[data-item-id]');
  return row && element.dataset.itemAction ? { listId: state.selected, id: row.dataset.itemId, action: element.dataset.itemAction } : null;
}
function restoreItemFocus(target) {
  pendingFocus = null;
  if (!accountId || target.listId !== state.selected) return;
  const control = [...document.querySelectorAll('[data-item-id] button')].find(element =>
    element.closest('[data-item-id]').dataset.itemId === target.id && element.dataset.itemAction === target.action);
  const destination = control && !control.disabled && control.checkVisibility() ? control : current() ? $('sharedTitle') : $('sharedSelect');
  destination.focus();
  // Keep the intended action through busy renders, unless the user moves elsewhere.
  if (control?.disabled && control.checkVisibility()) pendingFocus = { ...target, anchor: destination };
}
function render() {
  if (!accountId) return;
  $('sharedMain').setAttribute('aria-busy', String(working || syncing));
  $('sharedExport').disabled = working;
  const list = current(), focused = document.activeElement;
  const target = itemFocus(focused) || (pendingFocus?.anchor === focused ? pendingFocus : null);
  pendingFocus = null;
  const entries = new Map(state.directory.map(item => [item.id, item]));
  for (const item of Object.values(state.lists)) entries.set(item.id, item);
  $('sharedSelect').replaceChildren(new Option('Choose a list', ''), ...[...entries.values()].map(item => new Option(`${item.title}${item.deleted ? ' (deleted)' : ''}`, item.id)));
  if (state.selected && !entries.has(state.selected)) $('sharedSelect').add(new Option('Pending or unavailable list', state.selected));
  $('sharedSelect').value = state.selected;
  $('sharedMore').hidden = !cursor;
  $('sharedContent').hidden = !list;
  $('sharedPending').hidden = !state.pending;
  if (state.pending) {
    const op = state.pending.operation;
    message('pendingText', `${op.action} · ${op.listId}\n${JSON.stringify({ ...op.fields, ...('token' in op.fields ? { token: '(invitation code kept privately for retry)' } : {}) }, null, 2)}\n${state.pending.error || 'Saved on device — pending server confirmation.'}`);
    $('reviewShared').hidden = state.pending.code !== 'shared_conflict' || !state.lists[op.listId] || ['create', 'join', 'invite', 'deleteList', 'restoreList', 'permissions', 'revoke', 'cancelInvite'].includes(op.action);
  }
  for (const id of ['createShared', 'joinShared']) $(id).querySelector('button').disabled = working || syncing || !!state.pending;
  $('retryShared').disabled = $('reviewShared').disabled = $('discardShared').disabled = working || syncing;
  message('sharedStatus', !navigator.onLine ? 'Offline — showing the last saved copy. Permissions are checked again when you reconnect.' : state.pending ? 'An action is saved on this device and needs confirmation.' : 'Shared device copy ready. Refresh to check for changes.');
  if (!list) {
    if (target || $('sharedContent').contains(focused)) $('sharedSelect').focus();
    return;
  }
  $('sharedTitle').textContent = list.title;
  $('sharedAccess').textContent = list.deleted ? 'Deleted. Only the owner can restore this list.' : `${list.owner ? 'You own this list.' : 'Your permissions: ' + list.permissions.join(', ') + '.'} Revision ${list.revision}.`;
  $('addShared').hidden = !list.permissions.includes('add') || list.deleted;
  $('addShared').querySelector('button').disabled = !can('add');
  for (const [deleted, target] of [[false, 'sharedItems'], [true, 'sharedDeleted']]) {
    $(target).replaceChildren(...list.items.filter(item => item.deleted === deleted).map(item => {
      const article = document.createElement('article'), title = document.createElement('h3'), actions = document.createElement('div'); actions.className = 'actions';
      article.dataset.itemId = item.id;
      title.textContent = `${item.completed ? '✓ ' : ''}${item.title}`;
      if (deleted) actions.append(button('Restore ' + item.title, () => save('restoreItem', { id: item.id }), !can('delete')));
      else {
        actions.append(button((item.completed ? 'Reopen ' : 'Complete ') + item.title, () => save('complete', { id: item.id, completed: !item.completed }), !can('complete')));
        actions.append(button('Edit ' + item.title, () => {
          editItem = { ...item, listId: list.id, revision: list.revision }; editorOpener = { listId: list.id, id: item.id, action: 'edit' };
          $('editShared').elements.title.value = state.drafts[list.id]?.edit?.id === item.id ? state.drafts[list.id].edit.title : item.title;
          $('sharedEditor').showModal(); $('editShared').elements.title.focus();
        }, !can('edit')));
        actions.append(button('Delete ' + item.title, () => save('delete', { id: item.id }), !can('delete')));
      }
      [...actions.children].forEach((control, index) => { control.dataset.itemAction = deleted ? 'restore' : ['complete', 'edit', 'delete'][index]; });
      article.append(title, actions); return article;
    }));
    if (!$(target).childElementCount) $(target).textContent = deleted ? 'No deleted items.' : 'No items yet.';
  }
  $('sharedOwner').hidden = !list.owner;
  $('renameShared').hidden = $('inviteShared').hidden = $('deleteShared').hidden = list.deleted;
  $('restoreShared').hidden = !list.deleted;
  $('deleteShared').disabled = $('restoreShared').disabled = working || syncing || !!state.pending;
  $('renameShared').querySelector('button').disabled = $('inviteShared').querySelector('button').disabled = working || syncing || !!state.pending;
  if (document.activeElement !== $('renameShared').elements.title) $('renameShared').elements.title.value = list.title;
  $('invitationResult').hidden = !invitation || invitation.listId !== list.id || list.deleted;
  $('sharedInvitations').replaceChildren(...(list.invitations || []).map(entry => {
    const p = document.createElement('p'); p.append(`Expires ${new Date(entry.expiresAt).toLocaleString()} · ${entry.permissions.join(', ')} `,
      button('Cancel invitation', () => save('cancelInvite', { id: entry.id }), working || !!state.pending)); return p;
  }));
  $('sharedMembers').replaceChildren(...(list.members || []).map(member => {
    const form = document.createElement('form'), heading = document.createElement('h4'), controls = document.createElement('fieldset');
    heading.textContent = member.name; permissionControls(controls, member.permissions);
    form.append(heading, controls, button('Save permissions for ' + member.name, () => save('permissions', { accountId: member.accountId, permissions: selectedRights(controls) }), working || !!state.pending),
      button('Remove ' + member.name, () => { if (confirm(`Remove ${member.name} from this list? Previously downloaded copies cannot be erased.`)) return save('revoke', { accountId: member.accountId }); }, working || !!state.pending));
    return form;
  }));
  if (!document.querySelector('dialog[open]')) {
    if (target) restoreItemFocus(target);
    else if (focused !== document.body && !focused.isConnected) $('sharedTitle').focus();
  }
}
async function directory(more = false) {
  const result = await request('shared/lists' + (more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  cursor = result.cursor;
  await local(data => { data.directory = more ? [...data.directory, ...result.lists] : result.lists; });
}
async function pull(id = state.selected) {
  if (!id) return;
  const invalidation = (await local()).invalidations?.[id] || 0;
  try {
    const result = await request('shared/list?id=' + encodeURIComponent(id));
    await local(data => {
      if ((data.invalidations?.[id] || 0) === invalidation &&
          (data.lists[id]?.revision || 0) <= result.list.revision) data.lists[id] = result.list;
    });
  } catch (error) {
    if (error.code === 'shared_access_denied') {
      await local(data => {
        data.invalidations ??= {};
        data.invalidations[id] = (data.invalidations[id] || 0) + 1;
        delete data.lists[id]; data.directory = data.directory.filter(list => list.id !== id);
      });
      if (editItem?.listId === id) $('sharedEditor').close();
    }
    throw error;
  }
}
async function sync(force = false) {
  if (syncing || !accountId || !navigator.onLine) { render(); return; }
  syncing = true; render();
  const owner = accountId, epoch = generation;
  try {
    await verify();
    if (!navigator.locks) throw new Error('This browser cannot safely coordinate shared saves. Export your copy and use a browser with Web Locks.');
    await navigator.locks.request('todo-shared:' + owner, async () => {
      if (owner !== accountId || epoch !== generation) return;
      await local();
      const pending = state.pending;
      if (pending && (!pending.error || force)) {
        const op = pending.operation;
        try {
          const receipt = await request('shared/operations', op);
          if (receipt.operationId !== op.operationId || receipt.listId !== op.listId) throw new Error('Unexpected acknowledgement. Pending action is kept.');
          await local(data => {
            if (data.pending?.operation.operationId === op.operationId) data.pending = null;
            if (op.action === 'add' && data.drafts[op.listId]?.add === op.fields.title) data.drafts[op.listId].add = '';
            if (op.action === 'edit' && data.drafts[op.listId]?.edit?.title === op.fields.title) delete data.drafts[op.listId].edit;
            if (op.action === 'create' && data.createTitle === op.fields.title) data.createTitle = '';
          });
          if (op.action === 'invite') {
            invitation = { listId: op.listId, token: op.fields.token };
            $('invitationLink').value = `${location.origin}/shared.html#${new URLSearchParams(invitation)}`;
          }
          await pull(op.listId);
          if (op.action === 'add' && $('addShared').elements.title.value === op.fields.title) $('addShared').elements.title.value = '';
          if (op.action === 'create' && $('createShared').elements.title.value === op.fields.title) {
            $('createShared').reset(); $('createShared').closest('details').open = false;
          }
        } catch (error) {
          if (owner === accountId && epoch === generation) {
            await local(data => { if (data.pending?.operation.operationId === op.operationId) { data.pending.error = error.message; data.pending.code = error.code; } });
            if (['shared_conflict', 'shared_access_denied'].includes(error.code)) { try { await pull(op.listId); } catch { /* Recovery retains the original action. */ } }
          }
          throw error;
        }
      }
      await directory(); await pull();
    });
    message('sharedError', '');
  } catch (error) { message('sharedError', error.message); }
  finally { syncing = false; render(); }
}
async function save(action, fields, id = state.selected, revision = current()?.revision || 0) {
  if (syncing) throw new Error('Wait for the current refresh to finish, then save again.');
  if (!id) throw new Error('Choose a shared list first.');
  const operation = { accountId, listId: id, operationId: crypto.randomUUID(), expectedRevision: revision, action, fields };
  await local(data => {
    if (data.pending) throw new Error('Sync or resolve the pending action before saving another. Your text is kept.');
    data.pending = { operation }; data.selected = id;
  });
  render(); await sync();
}
async function run(action) {
  if (working) return;
  working = true; message('sharedError', '');
  try { const result = action(); render(); await result; }
  catch (error) { message('sharedError', error.message + ' Your entered text is kept.'); }
  finally { working = false; render(); }
}
function form(id, action) { $(id).onsubmit = event => { event.preventDefault(); void run(action); }; }
form('createShared', () => save('create', { title: $('createShared').elements.title.value }, crypto.randomUUID(), 0));
form('joinShared', async () => {
  await save('join', { token: $('joinShared').elements.token.value }, $('joinShared').elements.listId.value, 0);
  if (!state.pending) { $('joinShared').reset(); sessionStorage.removeItem('shared-invitation'); }
});
form('addShared', () => save('add', { id: crypto.randomUUID(), title: $('addShared').elements.title.value }));
form('editShared', async () => {
  await save('edit', { id: editItem.id, title: $('editShared').elements.title.value }, editItem.listId, editItem.revision);
  $('sharedEditor').close();
});
form('renameShared', () => save('rename', { title: $('renameShared').elements.title.value }));
form('inviteShared', () => save('invite', { id: crypto.randomUUID(), token: crypto.randomUUID() + crypto.randomUUID(), permissions: selectedRights($('invitePermissions')) }));
$('closeSharedEdit').onclick = () => $('sharedEditor').close();
$('sharedEditor').addEventListener('close', () => {
  // A delayed close event must not override a later focus choice or account change.
  if (editorOpener && (document.activeElement === document.body || $('sharedEditor').contains(document.activeElement))) restoreItemFocus(editorOpener);
});
$('createShared').oninput = () => void local(data => { data.createTitle = $('createShared').elements.title.value; }).catch(error => message('sharedError', 'Draft not saved: ' + error.message));
$('addShared').oninput = () => {
  const id = state.selected, value = $('addShared').elements.title.value;
  void local(data => { (data.drafts[id] ??= {}).add = value; }).catch(error => message('sharedError', 'Draft not saved: ' + error.message));
};
$('editShared').oninput = () => {
  const item = editItem, title = $('editShared').elements.title.value;
  void local(data => { (data.drafts[item.listId] ??= {}).edit = { id: item.id, title }; }).catch(error => message('sharedError', 'Draft not saved: ' + error.message));
};
$('sharedSelect').onchange = () => void run(async () => {
  const id = $('sharedSelect').value; await local(data => { data.selected = id; }); restoreInputs(); render();
  if (navigator.onLine) { await verify(); await pull(id); } $('sharedTitle').focus();
});
$('sharedRefresh').onclick = $('retryShared').onclick = () => void sync(true);
$('sharedMore').onclick = () => void run(() => directory(true));
$('copyInvitation').onclick = () => void run(async () => { $('invitationLink').select(); await navigator.clipboard.writeText($('invitationLink').value); });
$('deleteShared').onclick = () => void run(() => { if (confirm('Delete this shared list and revoke everyone’s access? Its items stay stored and only you can restore it. There is no automatic purge.')) return save('deleteList', {}); });
$('restoreShared').onclick = () => void run(() => save('restoreList', {}));
$('discardShared').onclick = () => void run(async () => {
  const id = state.pending?.operation.operationId;
  if (!confirm('Remove this pending action? Export a shared device copy first if you need its text.')) return;
  await local(data => { if (data.pending?.operation.operationId === id) data.pending = null; });
});
$('reviewShared').onclick = () => void run(async () => {
  const pending = structuredClone(state.pending);
  if (!pending || pending.code !== 'shared_conflict') return;
  await verify(); await pull(pending.operation.listId); render();
  const list = state.lists[pending.operation.listId];
  const item = list.items.find(item => item.id === pending.operation.fields.id);
  if (!confirm(`Latest list: ${list.title}, revision ${list.revision}.\nCurrent item: ${item ? JSON.stringify(item) : 'No item with this ID'}\nYour action: ${pending.operation.action} ${JSON.stringify(pending.operation.fields)}\nApply your action to this reviewed version?`)) return;
  await local(data => {
    if (data.pending?.operation.operationId !== pending.operation.operationId) throw new Error('Pending action changed. Review again.');
    data.pending = { operation: { ...pending.operation, operationId: crypto.randomUUID(), expectedRevision: list.revision } };
  });
  await sync(true);
});
$('sharedExport').onclick = () => void run(async () => {
  try { await local(); } catch { /* Export the memory copy if IndexedDB is unavailable. */ }
  const copy = structuredClone(state); if (copy.pending?.operation.fields.token) copy.pending.operation.fields.token = '(invitation code omitted)';
  copy.currentForm = { listId: state.selected, add: $('addShared').elements.title.value, create: $('createShared').elements.title.value,
    edit: editItem ? { ...editItem, title: $('editShared').elements.title.value } : null };
  const blob = new Blob([JSON.stringify({ format: 'az-todo-shared-device-copy', accountId, exportedAt: new Date().toISOString(), state: copy }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'shared-lists-device-copy.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const channel = new BroadcastChannel('todo-inbox');
channel.onmessage = async () => {
  const session = await transact(null);
  if (session.paused || accountId && session.accountId !== accountId) { clearAccount(); $('sharedSignIn').hidden = false; message('sharedStatus', 'Account changed. Sign in to reopen shared lists.'); }
};
addEventListener('online', () => void sync()); addEventListener('offline', render);
addEventListener('focus', () => void sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
try {
  if (location.hash) {
    const params = new URLSearchParams(location.hash.slice(1));
    if (/^[A-Za-z0-9_-]{1,128}$/.test(params.get('listId') || '') && /^[A-Za-z0-9_-]{40,128}$/.test(params.get('token') || '')) sessionStorage.setItem('shared-invitation', JSON.stringify({ listId: params.get('listId'), token: params.get('token') }));
    history.replaceState(null, '', location.pathname);
  }
  const savedInvite = JSON.parse(sessionStorage.getItem('shared-invitation') || 'null');
  if (savedInvite) { $('joinShared').elements.listId.value = savedInvite.listId; $('joinShared').elements.token.value = savedInvite.token; $('joinDetails').open = true; }
  if (navigator.onLine) await verify();
  else {
    const session = await transact(null);
    if (!session.accountId || session.paused) throw new Error('Sign in online before opening shared lists on this device.');
    accountId = session.accountId; await local(); $('sharedMain').hidden = false;
  }
  restoreInputs(); render(); await sync();
} catch (error) { message('sharedError', error.message); $('sharedSignIn').hidden = false; }
