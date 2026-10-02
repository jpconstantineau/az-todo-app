import { transact, key, projected, enqueue, applyReceipt, captureMutations } from './inbox-store.js?v=16';
import { optionFields, formValues, fillValues, localDate, taskFields, addTaskControls, refreshTaskOptions, defaultsFrom, validateWorkflow, reviewReady } from './inbox-fields.js?v=16';
import { deviceExport, readableExport } from './inbox-export.js?v=16';
import { clarificationUI } from './clarification.js?v=16';
import { setupReviews } from './reviews.js?v=16';

const $ = id => document.getElementById(id);
const capture = $('capture'), edit = $('edit');
let accountId = null, state, editing = null, originalInput;
let saving = false, syncing = true, retryTimer, retryDelay = 2000, accountGeneration = 0;
let defaultsEditing = null;
const dialogOpeners = new Map();
const clarification = clarificationUI({ records: () => projected(state), journal, save: saveClarification, showDialog });
async function saveClarification(mutations, next) {
  const owner = accountId;
  if (!owner) return false;
  const saved = await transact(owner, local => {
    const records = projected(local);
    if (!records[`item:${next.item.id}`] || records[`item:${next.item.id}`].deleted) throw new Error('This item is no longer available. Your proposal remains in the device draft.');
    for (const mutation of mutations) {
      const current = records[key(mutation)];
      if (current?.deleted || (current?.version || 0) !== mutation.expectedVersion) throw new Error('This item or clarification changed. Your draft is kept. Stop, export a copy, and reopen the latest clarification to compare.');
    }
    enqueue(local, owner, mutations);
    local.draft.clarification = next;
  }).catch(failure => { if (owner === accountId) storageFailure(failure); throw failure; });
  if (owner !== accountId) return false;
  state = saved; render(); broadcast(); void sync(); return true;
}
let destination = 'capture';
const emptyNavigation = () => ({ work: { view: 'all', status: '' }, lists: { view: '', status: '' } });
let navigation = emptyNavigation();
const reviews = setupReviews({ current: () => accountId ? state : null, journal, showDialog, save: async mutations => {
  const owner = accountId, generation = accountGeneration;
  if (!owner) throw new Error('Sign in to resume this review.');
  const saved = await transact(owner, local => {
    if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before continuing this review.');
    const records = projected(local);
    for (const mutation of mutations) {
      const current = records[key(mutation)];
      if ((current?.version || 0) !== mutation.expectedVersion || current?.deleted) throw new Error('This review or record changed. Reopen the review and inspect the latest state before deciding.');
    }
    enqueue(local, owner, mutations);
  }).catch(failure => { if (owner === accountId) storageFailure(failure); throw failure; });
  if (owner !== accountId || generation !== accountGeneration) throw new Error('Account changed; the save remains with its original account.');
  state = saved; clearError(); render(); broadcast(); void sync();
} });
addTaskControls($('captureFields')); addTaskControls($('editFields'));
for (const [name, title] of Object.entries(optionFields)) {
  const label = document.createElement('label'); label.textContent = title;
  const input = document.createElement('textarea'); input.name = name; input.rows = 3;
  label.append(input); $('defaultsFields').append(label);
}
function userDefaults() { return { ...state.defaultSettings, ...(projected(state)['settings:settings']?.defaults ?? state.legacyDefaults) }; }
function effectiveDefaults(listId) { return { ...userDefaults(), ...projected(state)[`list:${listId}`]?.defaults }; }
function refreshOptions() {
  refreshTaskOptions(capture, effectiveDefaults(capture.elements.listId.value));
  refreshTaskOptions(edit, effectiveDefaults(edit.elements.listId.value));
}
const channel = new BroadcastChannel('todo-inbox');
const broadcast = () => channel.postMessage('changed');
function statusText(id, text) {
  // Replacing identical live-region text can announce it again on every keystroke/render.
  if ($(id).textContent !== text) $(id).textContent = text;
}
function error(message, kind = 'local') {
  $('error').hidden = false; statusText('error', message); $('error').dataset.kind = kind;
  if ($('editor').open) { $('editError').hidden = false; statusText('editError', message); }
  if ($('defaultsEditor').open) { $('defaultsError').hidden = false; statusText('defaultsError', message); }
}
function clearError(kind) {
  if (!kind || $('error').dataset.kind === kind) { $('error').hidden = true; $('editError').hidden = true; }
}
function captureDraft() {
  return { ...formValues(capture), ...(originalInput === undefined ? {} : { original: originalInput }) };
}
function draft() {
  return { capture: captureDraft(), edit: editing ? { ...editing, fields: formValues(edit) } : null,
    defaults: defaultsEditing ? { ...defaultsEditing, values: formValues($('defaultsForm')) } : null,
    defaultsOpen: $('defaultsEditor').open, clarification: clarification.snapshot(),
    day: $('day').value, navigation: structuredClone(navigation), review: reviews.draft() };
}
function storageFailure(failure) {
  error(`Could not save on this device: ${failure.message}. Your text has been kept. Copy or export it before leaving.`);
  statusText('draftStatus', 'Not saved on device');
  $('recovery').hidden = false;
  $('recoveryText').value = JSON.stringify({ accountId, draft: draft(), localCopy: state }, null, 2);
  $('editor').close(); // Make the recovery copy outside the modal reachable.
  $('defaultsEditor').close();
  $('reviews').close();
  clarification.close();
}
function guard(action) {
  return (...args) => Promise.resolve().then(() => action(...args)).catch(failure => error(failure.message));
}
async function journal() {
  if (!accountId) return;
  const owner = accountId, snapshot = draft();
  try {
    const saved = await transact(owner, local => { local.draft = snapshot; });
    if (owner === accountId) { state = saved; statusText('draftStatus', 'Draft saved on device'); statusText('clarifyDraftStatus', 'Draft saved on device; not accepted.'); }
  } catch (failure) { if (owner === accountId) storageFailure(failure); }
}
function options(select, lists, first, keepMissing = false) {
  const selected = select.value;
  select.replaceChildren(...first.map(([value, text]) => new Option(text, value)), ...lists.map(list => new Option(list.title, list.id)));
  if (keepMissing && selected && ![...select.options].some(option => option.value === selected)) select.add(new Option('Unavailable project — choose another or clear', selected));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}
function restoreDraft() {
  capture.reset(); edit.reset(); editing = null; originalInput = undefined;
  const saved = state.draft;
  fillValues(capture, saved.capture || {});
  originalInput = saved.capture?.original;
  $('previewHelp').hidden = originalInput === undefined;
  navigation = emptyNavigation();
  // Preserve the former review filter when upgrading an existing device draft.
  Object.assign(navigation.work, saved.navigation?.work || { view: saved.view || 'all', status: saved.status || '' });
  Object.assign(navigation.lists, saved.navigation?.lists || {});
  $('day').value = saved.day ?? localDate(new Date().toISOString()).slice(0, 10);
  workspace(false);
  // Keep unfinished list creation available through New list without opening it on arrival.
  if (saved.edit) openEditor(saved.edit, false, !(saved.edit.type === 'list' && saved.edit.version === 0));
  else $('editor').close();
  if (saved.defaults) openDefaults(saved.defaults, false, saved.defaultsOpen !== false);
  refreshOptions(); render();
  reviews.restore(saved.review);
  clarification.restore(saved.clarification);
}
function button(text, handler, label = text, focusKey) {
  const element = document.createElement('button'); element.textContent = text;
  element.setAttribute('aria-label', label);
  if (focusKey) element.dataset.focusKey = focusKey;
  element.addEventListener('click', guard(handler)); return element;
}
function render() {
  if (!accountId || !state) return;
  const focused = document.activeElement;
  const records = Object.values(projected(state)).filter(record => !record.deleted);
  const lists = records.filter(record => record.type === 'list');
  const projects = records.filter(record => record.type === 'project');
  options(capture.elements.listId, lists, [['', 'Inbox (no list)']]);
  options(edit.elements.listId, lists, [['', 'Inbox (no list)']]);
  options(capture.elements.projectId, projects, [['', 'No project']], true);
  options(edit.elements.projectId, projects, [['', 'No project']], true);
  const listMode = destination === 'lists';
  const filters = navigation[listMode ? 'lists' : 'work'];
  options($('view'), listMode ? lists : [...lists, ...projects.map(project => ({ id: `project:${project.id}`, title: `Project: ${project.title}` }))],
    listMode ? [['', 'Choose a list']] : [['all', 'All items'], ['inbox', 'Inbox (no list)'], ['day', 'Planned day']]);
  $('view').value = [...$('view').options].some(option => option.value === filters.view) ? filters.view : listMode ? '' : 'all';
  filters.view = $('view').value;
  refreshOptions();
  const statuses = [...new Set(['inbox', 'next', 'waiting', 'deferred', 'completed', 'dropped', ...(userDefaults().statuses || []), ...lists.flatMap(list => list.defaults?.statuses || []), ...records.filter(record => record.type === 'item').map(record => record.status)])];
  options($('statusFilter'), statuses.map(status => ({ id: status, title: status })), [['', 'All statuses'], ['@review-ready', 'Ready for review']]);
  $('statusFilter').value = [...$('statusFilter').options].some(option => option.value === filters.status) ? filters.status : '';
  filters.status = $('statusFilter').value;
  statusText('syncStatus', state.queue.length ? `${state.queue.length} save(s) on device — ${state.queue.some(entry => entry.failure) ? 'failed / needs attention' : 'pending server confirmation'}.` : 'All saved work is server-confirmed.');
  $('lists').replaceChildren(...lists.filter(list => listMode && list.id === filters.view).flatMap(list => [button(`Edit list: ${list.title}`, () => openEditor(list), `Edit list: ${list.title}`, `${key(list)}:edit`), button(`Defaults: ${list.title}`, () => openDefaults(list), `Defaults: ${list.title}`, `${key(list)}:defaults`)]));
  const view = $('view').value;
  $('dayLabel').hidden = view !== 'day';
  const project = projects.find(project => view === `project:${project.id}`);
  $('projectOutcome').hidden = !project;
  $('projectOutcome').textContent = project ? `Desired outcome: ${project.outcome}` : '';
  $('projectActions').replaceChildren(...(project ? [button('Edit project', () => openEditor(project), `Edit project: ${project.title}`, `${key(project)}:edit`)] : []));
  $('items').replaceChildren(...records.filter(record => {
    if (record.type !== 'item' || ($('statusFilter').value && ($('statusFilter').value === '@review-ready' ? !reviewReady(record) : record.status !== $('statusFilter').value))) return false;
    if (view === 'all') return true;
    if (view === 'inbox') return !record.listId;
    if (view === 'day') return !!$('day').value && record.plannedDay === $('day').value;
    if (view.startsWith('project:')) return record.projectId === project?.id;
    return record.listId === view;
  }).map(record => {
    const article = document.createElement('article'); article.dataset.id = record.id;
    const title = document.createElement('h3'); title.textContent = record.title;
    const notes = document.createElement('p'); notes.className = 'notes'; notes.textContent = record.description;
    const metadata = document.createElement('p'); metadata.className = 'notes';
    metadata.textContent = [...(record.contexts || []), ...(record.areas || []), record.energy, record.timeRequired, record.priority].filter(Boolean).join(' · ');
    if (record.projectId) metadata.append(` · Project: ${projects.find(project => project.id === record.projectId)?.title || 'Unavailable project'}`);
    if (record.plannedDay) metadata.append(` · Planned: ${record.plannedDay}`);
    if (record.dueDateUtc) { const time = document.createElement('time'); time.dateTime = record.dueDateUtc; time.textContent = ` Due ${new Date(record.dueDateUtc).toLocaleString()}`; metadata.append(time); }
    for (const [name, label] of [['dueDate', 'Deadline'], ['waitingOn', 'Waiting for'], ['startDate', 'Deferred until'], ['startDateUtc', 'Deferred until'], ['reviewDate', 'Review on'], ['reviewDateUtc', 'Review on']]) {
      if (record[name]) metadata.append(` · ${label}: ${name.endsWith('Utc') ? new Date(record[name]).toLocaleString() : record[name]}`);
    }
    if (reviewReady(record)) metadata.append(' · Ready for review — choose Next or set a new date');
    const status = document.createElement('p'); status.className = 'record-state'; status.dataset.pending = String(!!record.localState);
    status.textContent = `${record.status || 'inbox'} · ${record.localState || 'Server-confirmed'}`;
    const actions = document.createElement('div'); actions.className = 'actions';
    const action = record.status === 'completed' ? 'Reopen' : 'Complete';
    actions.append(button('Edit', () => openEditor(record), `Edit ${record.title}`, `${key(record)}:edit`),
      button('Clarify', () => clarification.open(record), `Clarify ${record.title}`, `${key(record)}:clarify`),
      button(action, () => updateRecord(record, { status: record.status === 'completed' ? record.statusBeforeCompletion || 'next' : 'completed' }), `${action} ${record.title}`, `${key(record)}:complete`));
    if (record.workflowBeforeTransition) actions.append(button('Undo state change', () => updateRecord(record, record.workflowBeforeTransition), `Undo state change ${record.title}`, `${key(record)}:undo`));
    article.append(title, notes, metadata, status, actions); return article;
  }));
  if (!$('items').childElementCount) $('items').textContent = listMode && !view
    ? (lists.length ? 'Choose a list to see its items and manage its details.' : 'No lists yet. Create a list, or use Capture without one.')
    : 'No items match this view. Change the filters or use Capture to add work.';
  const failed = state.queue[0]?.failure ? state.queue[0] : null;
  $('failure').hidden = !failed;
  if (failed) {
    $('failureMessage').textContent = failed.failure;
    const describe = record => !record ? 'No server record' : record.deleted ? 'Deleted on server' :
      [['step', 'Clarification step'], ['answers', 'Accepted answers / unknowns'], ['proposal', 'Unaccepted proposal'], ['reviewKind', 'Review kind'], ['included', 'Included records'], ['decisions', 'Decision history'], ['title', 'Title'], ['description', 'Notes'], ['outcome', 'Desired outcome'], ['projectId', 'Project ID'], ['plannedDay', 'Planned day'], ['status', 'Status'], ['waitingOn', 'Waiting for'], ['startDate', 'Deferred until'], ['startDateUtc', 'Deferred until (UTC)'], ['reviewDate', 'Review on'], ['reviewDateUtc', 'Review on (UTC)'], ['dueDate', 'Deadline'], ['listId', 'List'], ['defaults', 'Defaults'], ['dueDateUtc', 'Due'], ['contexts', 'Contexts'], ['areas', 'Areas'], ['energy', 'Energy'], ['timeRequired', 'Time required'], ['priority', 'Priority']]
        .filter(([field]) => field in record).map(([field, label]) => `${label}: ${field === 'listId' ? lists.find(list => list.id === record[field])?.title || 'Inbox / unavailable list' : typeof record[field] === 'object' ? JSON.stringify(record[field], null, 2) : record[field]}`).join('\n');
    $('comparison').textContent = failed.operation.mutations.map(mutation =>
      `Pending ${mutation.type}\n${describe(mutation.fields)}\n\nServer version\n${describe(state.records[key(mutation)])}`).join('\n\n——\n\n');
    $('resolve').hidden = !failed.receipt || failed.operation.mutations.some(mutation => mutation.type === 'review' || mutation.action !== 'update' || !state.records[key(mutation)] || state.records[key(mutation)].deleted);
    $('discard').textContent = failed.receipt ? 'Use server version for this save' : 'Remove this rejected save';
  }
  reviews.render();
  if (!focused.isConnected || (focused !== document.body && !focused.getClientRects().length)) restoreFocus(focused);
}
function openEditor(record, focus = true, show = true) {
  if (editing?.id === record.id && editing.type === record.type && editing.version === record.version) {
    if (show) showDialog($('editor'));
    if (focus) edit.elements.title.focus();
    return;
  }
  editing = { type: record.type, id: record.id, version: record.version, initialFields: record.initialFields };
  edit.reset();
  const fields = record.fields ? projected(state)[key(record)] || record.fields : record;
  edit.elements.title.value = fields.title;
  edit.elements.description.value = fields.description || '';
  edit.elements.listId.value = fields.listId || '';
  refreshOptions();
  fillValues(edit, { ...fields, dueLocal: fields.dueLocal ?? localDate(fields.dueDateUtc), status: fields.status || 'inbox' });
  editing.initialFields ??= formValues(edit);
  if (record.fields) fillValues(edit, record.fields);
  $('editListLabel').hidden = record.type !== 'item';
  $('editAdvanced').hidden = record.type !== 'item';
  $('editOutcomeLabel').hidden = record.type !== 'project';
  edit.elements.outcome.required = record.type === 'project';
  $('editHeading').textContent = `${record.version ? 'Edit' : 'New'} ${record.type}`;
  $('original').textContent = projected(state)[key(record)]?.originalText || '';
  $('editError').hidden = true;
  if (show) showDialog($('editor'));
  if (focus) { edit.elements.title.focus(); void journal(); }
}

async function updateRecord(record, fields, close = false) {
  const owner = accountId;
  if (!owner) return;
  if (fields.title !== undefined && (!fields.title.trim() || fields.title.length > 200)) throw new Error('Title must be 1–200 characters.');
  if ((fields.description?.length ?? 0) > 4000) throw new Error('Notes must be at most 4,000 characters.');
  if (fields.outcome !== undefined && (!fields.outcome.trim() || fields.outcome.length > 4000)) throw new Error('Describe the desired outcome in 1–4,000 characters.');
  if (record.type === 'item') {
    const old = projected(state)[key(record)];
    validateWorkflow({ ...old, ...fields }, old, fields);
  }
  try {
    const saved = await transact(owner, local => {
      const current = projected(local)[key(record)];
      if (record.version !== 0 && (!current || current.deleted || current.version !== record.version)) throw new Error('This record changed while you were editing. Your draft is still here; copy it, then reopen the latest record to compare.');
      enqueue(local, owner, [{ type: record.type, id: record.id, action: record.version === 0 ? 'create' : 'update', expectedVersion: record.version, fields }]);
      if (close) local.draft.edit = null;
    });
    if (owner === accountId) state = saved;
  } catch (failure) { if (owner === accountId) storageFailure(failure); return; }
  if (owner !== accountId) return;
  if (close) { editing = null; $('editor').close(); }
  clearError(); render();
  broadcast(); void sync();
}

capture.addEventListener('input', () => { void journal(); });
edit.addEventListener('input', () => { void journal(); });
capture.elements.listId.addEventListener('change', refreshOptions);
edit.elements.listId.addEventListener('change', refreshOptions);
capture.addEventListener('submit', event => {
  event.preventDefault();
  if (saving || !accountId) return;
  saving = true; capture.querySelector('[type=submit]').disabled = true;
  void (async () => {
    const owner = accountId, submitted = captureDraft();
    try {
      const mutations = captureMutations(submitted);
      const details = taskFields(submitted);
      for (const mutation of mutations) {
        if (mutation.type === 'item') Object.assign(mutation.fields, details);
        else mutation.fields.defaults = structuredClone(userDefaults());
      }
      const saved = await transact(owner, local => {
        enqueue(local, owner, mutations);
        if (JSON.stringify(local.draft.capture) === JSON.stringify(submitted)) local.draft.capture = {};
      });
      if (owner !== accountId) return;
      state = saved;
      if (JSON.stringify(captureDraft()) === JSON.stringify(submitted)) {
        capture.reset(); originalInput = undefined; $('previewHelp').hidden = true;
      }
      clearError(); statusText('draftStatus', 'Saved on device');
      render(); capture.elements.text.focus(); broadcast(); void sync();
    } catch (failure) { if (owner === accountId) storageFailure(failure); }
    finally { saving = false; capture.querySelector('[type=submit]').disabled = false; }
  })();
});
edit.addEventListener('submit', event => {
  event.preventDefault();
  if (saving || !editing) return;
  saving = true;
  let fields;
  try {
    const values = formValues(edit);
    fields = { title: values.title, description: values.description,
      ...(editing.type === 'item' ? { listId: values.listId || null, ...taskFields(values, editing.initialFields) } : editing.type === 'project' ? { outcome: values.outcome } : {}) };
    if (editing.version === 0 && editing.type === 'list') fields.defaults = structuredClone(userDefaults());
    else if (editing.initialFields) {
      const initial = { ...editing.initialFields, ...taskFields(editing.initialFields, editing.initialFields), listId: editing.initialFields.listId || null };
      fields = Object.fromEntries(Object.entries(fields).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(initial[name])));
      if (!Object.keys(fields).length) { saving = false; $('editor').close(); return; }
    }
  } catch (failure) { saving = false; error(failure.message); return; }
  // Keep the submitted form stable until its local transaction commits.
  const controls = [...edit.elements]; controls.forEach(control => { control.disabled = true; });
  void updateRecord(editing, fields, true).catch(failure => error(failure.message)).finally(() => {
    saving = false; controls.forEach(control => { control.disabled = false; });
  });
});
$('previewSplit').onclick = () => {
  originalInput ??= capture.elements.text.value;
  capture.elements.text.value = capture.elements.text.value.split(/[,;\n]+/).map(line => line.trim()).filter(Boolean).join('\n');
  $('previewHelp').hidden = false; capture.elements.text.focus(); void journal();
};
$('cancelEdit').onclick = () => $('editor').close();
$('editor').addEventListener('close', () => { if (editing) void journal(); });
$('editor').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
function focusDestination() {
  if (!accountId || $('workspace').hidden) return;
  const modal = document.querySelector('dialog[open]');
  if (modal) {
    if (!modal.contains(document.activeElement)) modal.querySelector('input, textarea, select, button')?.focus();
    return;
  }
  (destination === 'capture' ? capture.elements.text : $('itemsHeading')).focus();
}
function restoreFocus(control) {
  if (document.querySelector('dialog[open]')) { focusDestination(); return; }
  // Labels and DOM nodes can change; record ID plus action remains stable.
  const target = control?.isConnected ? control : control?.dataset.focusKey
    ? document.querySelector(`[data-focus-key="${CSS.escape(control.dataset.focusKey)}"]`) : null;
  if (target && target !== document.body && !target.disabled && target.getClientRects().length) target.focus();
  else focusDestination();
}
function showDialog(dialog) {
  if (dialog.open) return;
  dialogOpeners.set(dialog, { control: document.activeElement, generation: accountGeneration });
  dialog.showModal();
}
function workspace(focus = true) {
  destination = ['work', 'lists'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'capture';
  const listMode = destination === 'lists';
  document.querySelector('.capture-panel').hidden = destination !== 'capture';
  document.querySelector('.work-panel').hidden = destination === 'capture';
  $('listTools').hidden = !listMode;
  $('newProject').hidden = listMode;
  $('itemsHeading').textContent = listMode ? 'List Workspace' : 'Your Work';
  $('workEyebrow').textContent = listMode ? 'Organize' : 'Review';
  $('workHelp').textContent = listMode ? 'Choose a list to manage its details, defaults and items.' : 'Review items across your account, or narrow by list and status.';
  $('viewLabel').textContent = listMode ? 'List' : 'View';
  for (const link of document.querySelectorAll('.workspace-nav a')) {
    if (link.hash === '#' + destination) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = (destination === 'capture' ? 'Capture' : listMode ? 'List Workspace' : 'Your Work') + ' · To-Do';
  render();
  if (focus) { focusDestination(); void journal(); }
}
addEventListener('hashchange', () => workspace());
for (const link of document.querySelectorAll('.workspace-nav a')) {
  link.addEventListener('click', event => {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && link.hash === location.hash) focusDestination();
  });
}
document.querySelector('.skip-link').onclick = event => {
  event.preventDefault();
  if (accountId) focusDestination(); else $('signIn').focus();
};
for (const dialog of [$('editor'), $('defaultsEditor'), $('preferences'), $('clarifier'), $('reviews')]) {
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const opener = dialogOpeners.get(dialog);
    dialogOpeners.delete(dialog);
    // Native close restores focus immediately, but its event can arrive after
    // another dialog has opened/closed. Keep a valid focus chosen since then.
    if (document.activeElement === document.body || !document.activeElement.getClientRects().length) {
      if (opener?.generation === accountGeneration) restoreFocus(opener.control);
      else focusDestination();
    }
  });
}
$('view').onchange = $('day').onchange = $('statusFilter').onchange = () => {
  navigation[destination === 'lists' ? 'lists' : 'work'] = { view: $('view').value, status: $('statusFilter').value };
  render(); void journal();
};
$('newList').onclick = () => openEditor(editing?.type === 'list' && editing.version === 0
  ? editing : { type: 'list', id: crypto.randomUUID(), version: 0, title: '', description: '' });
$('newProject').onclick = () => openEditor({ type: 'project', id: crypto.randomUUID(), version: 0, title: '', description: '', outcome: '' });
function openDefaults(record, focus = true, show = true) {
  if (!state.defaultSettings) { error('Reconnect once to load the built-in options before editing defaults. Your work is kept.'); return; }
  if (defaultsEditing?.id !== record.id || defaultsEditing?.type !== record.type || defaultsEditing?.version !== record.version) {
    defaultsEditing = { type: record.type, id: record.id, version: record.version };
    const defaults = record.type === 'list' ? effectiveDefaults(record.id) : userDefaults();
    const values = record.values || Object.fromEntries(Object.keys(optionFields).map(name => [name, (defaults[name] || []).join('\n')]));
    fillValues($('defaultsForm'), values);
  }
  $('defaultsHeading').textContent = record.type === 'settings' ? 'User defaults' : 'List defaults';
  $('resetDefaults').textContent = record.type === 'settings' ? 'Reset to built-in defaults' : 'Copy user defaults';
  $('defaultsError').hidden = true;
  if (show) showDialog($('defaultsEditor'));
  if (focus) {
    const control = $('defaultsForm').elements.contexts;
    control.focus(); control.setSelectionRange(0, 0); control.scrollTop = 0;
    void journal();
  }
}
$('userDefaults').onclick = () => openDefaults(projected(state)['settings:settings'] || { type: 'settings', id: 'settings', version: 0 });
$('closeDefaults').onclick = () => $('defaultsEditor').close();
$('defaultsEditor').addEventListener('close', () => { if (defaultsEditing) void journal(); });
$('defaultsEditor').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$('defaultsForm').addEventListener('input', () => { void journal(); });
$('resetDefaults').onclick = () => {
  const values = defaultsEditing.type === 'settings' ? state.defaultSettings : userDefaults();
  fillValues($('defaultsForm'), Object.fromEntries(Object.keys(optionFields).map(name => [name, (values[name] || []).join('\n')])));
  void journal();
};
$('defaultsForm').addEventListener('submit', event => {
  event.preventDefault();
  if (saving || !defaultsEditing || !accountId) return;
  let defaults;
  try { defaults = defaultsFrom($('defaultsForm')); } catch (failure) { error(failure.message); return; }
  saving = true;
  const owner = accountId, record = { ...defaultsEditing }, controls = [...$('defaultsForm').elements];
  controls.forEach(control => { control.disabled = true; });
  void (async () => {
    try {
      const saved = await transact(owner, local => {
        const current = projected(local)[key(record)];
        if ((current?.version || 0) !== record.version) throw new Error('Defaults changed while editing. Copy your options and reopen the latest defaults to compare.');
        enqueue(local, owner, [{ type: record.type, id: record.id, action: record.version ? 'update' : 'create', expectedVersion: record.version, fields: { defaults } }]);
        local.draft.defaults = null;
      });
      if (owner !== accountId) return;
      state = saved; defaultsEditing = null; $('defaultsEditor').close(); clearError(); render();
      broadcast(); void sync();
    } catch (failure) { if (owner === accountId) storageFailure(failure); }
    finally { saving = false; controls.forEach(control => { control.disabled = false; }); }
  })();
});
capture.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.repeat) { event.preventDefault(); capture.requestSubmit(); }
});
$('export').onclick = guard(async () => {
  if (!accountId || !state) return;
  const owner = accountId, generation = accountGeneration, currentDraft = draft(), memory = structuredClone(state);
  const readable = $('exportFormat').value === 'text';
  let snapshot, source = 'indexeddb';
  try { snapshot = await transact(owner); }
  catch { snapshot = memory; source = 'memory-recovery'; }
  if (owner !== accountId || generation !== accountGeneration) return;
  const value = deviceExport(owner, snapshot, currentDraft, source);
  const blob = new Blob([readable ? readableExport(value) : JSON.stringify(value, null, 2)], { type: readable ? 'text/plain;charset=utf-8' : 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = readable ? 'todo-tasks.txt' : 'todo-device-recovery.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('copyRecovery').onclick = guard(async () => {
  $('recoveryText').select(); await navigator.clipboard.writeText($('recoveryText').value);
});

async function request(path, operation) {
  const response = await fetch(`/api/v1/${path}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    signal: AbortSignal.timeout(15000), ...(operation ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation) } : {}) });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (response.status === 409 && body.status === 'conflict') return body;
  if (!response.ok) throw Object.assign(new Error(body.message || `Server returned ${response.status}. Pending work has been kept.`), { status: response.status, code: body.error });
  if (body.apiVersion !== 1) throw new Error('Unexpected server response. Pending work has been kept.');
  return body;
}
let profileRequest = 0;
async function showAccountName(owner, generation, verified) {
  const requestId = ++profileRequest;
  const offline = navigator.onLine ? '' : ' · Offline';
  let label = `Your device inbox${offline}`;
  if (!verified) { statusText('sessionStatus', label); return; }
  try {
    const response = await fetch('/.auth/me', { credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    const principal = (await response.json())?.clientPrincipal;
    if (requestId !== profileRequest || generation !== accountGeneration || owner !== accountId) return;
    if (principal?.userId === owner && typeof principal.userDetails === 'string' && principal.userDetails.trim()) {
      label = `Device inbox for ${principal.userDetails.trim()}${offline}`;
    }
  } catch { /* Display metadata must never block capture or synchronization. */ }
  finally {
    if (requestId === profileRequest && generation === accountGeneration && owner === accountId) statusText('sessionStatus', label);
  }
}
function hideAccount() {
  reviews.reset();
  if (accountId) history.replaceState(null, '', location.pathname + location.search + '#capture');
  navigation = emptyNavigation();
  $('view').replaceChildren(new Option('All items', 'all'));
  $('statusFilter').replaceChildren(new Option('All statuses', ''));
  $('failure').hidden = true; $('comparison').textContent = ''; $('failureMessage').textContent = '';
  $('syncStatus').textContent = ''; clearError();
  accountGeneration++;
  profileRequest++;
  $('sessionStatus').textContent = 'Your device inbox';
  accountId = null; state = undefined; editing = null; originalInput = undefined;
  clarification.hide();
  defaultsEditing = null; $('defaultsEditor').close(); $('defaultsForm').reset();
  $('editor').close(); $('editError').hidden = true; $('original').textContent = '';
  capture.reset(); edit.reset(); $('items').replaceChildren(); $('lists').replaceChildren();
  $('projectOutcome').textContent = ''; $('projectActions').replaceChildren(); $('day').value = '';
  $('recoveryText').value = ''; $('recovery').hidden = true; $('workspace').hidden = true; $('signOut').hidden = true; $('signIn').hidden = false;
}
async function pauseSession(message) {
  hideAccount();
  try { await transact(null, session => { session.paused = true; }); }
  catch { error('Could not record sign-out on this device. Keep this browser profile private; its offline cache may still be available.'); }
  broadcast(); $('sessionStatus').textContent = message;
}
async function session({ allowOffline = false } = {}) {
  let generation = accountGeneration;
  let identity, verified = false;
  try {
    identity = await request('session');
    if (typeof identity.accountId !== 'string' || !identity.accountId) throw new Error('Missing account identity.');
    verified = true;
  } catch (failure) {
    if (failure.status === 401 || failure.status === 403) {
      await pauseSession('Sign in to the original account to resume. Its pending work is kept on this device.');
      throw failure;
    }
    if (!allowOffline || failure.status) throw failure;
    const saved = await transact(null);
    if (!saved.accountId || saved.paused) throw new Error('Sign in online once before capturing on this device.');
    identity = { accountId: saved.accountId }; // Last verified account, never a newly guessed identity.
  }
  if (generation !== accountGeneration) throw new Error('Account changed while checking the session. Retry after signing in.');
  if (accountId !== identity.accountId) {
    const previous = (await transact(null)).accountId;
    hideAccount();
    if (previous && previous !== identity.accountId) history.replaceState(null, '', location.pathname + location.search + '#capture');
    generation = accountGeneration;
    await transact(null, saved => { saved.accountId = identity.accountId; saved.paused = false; });
    const saved = await transact(identity.accountId, local => {
      if (identity.defaultSettings) { local.defaultSettings = identity.defaultSettings; local.legacyDefaults = identity.legacyDefaults; }
    });
    if (generation !== accountGeneration) throw new Error('Account changed while opening its device copy. Reload to continue.');
    accountId = identity.accountId; state = saved;
    render(); $('workspace').hidden = false; restoreDraft(); broadcast();
  }
  $('workspace').hidden = false; $('signOut').hidden = false; $('signIn').hidden = true;
  void showAccountName(accountId, generation, verified);
  return accountId;
}

async function sync() {
  if (syncing || !navigator.onLine || document.hidden) return;
  syncing = true; clearTimeout(retryTimer);
  let continueSync = false;
  try {
    const owner = await session({ allowOffline: true });
    if (!navigator.locks) throw new Error('This browser cannot coordinate safe sync between tabs. Export your device copy and use a browser with Web Locks.');
    await navigator.locks.request(`todo-sync:${owner}`, async () => {
      // Bound foreground work, and atomically persist each page with its cursor.
      for (let page = 0; page < 10 && accountId === owner; page++) {
        const local = await transact(owner);
        const changes = await request(`changes?${new URLSearchParams({ accountId: owner, after: local.after, limit: 50 })}`);
        if (changes.accountId !== owner || !Number.isSafeInteger(changes.nextAfter) || changes.nextAfter < local.after) throw new Error('Unexpected change page. Local data has been kept.');
        await transact(owner, current => {
          for (const receipt of changes.entries) applyReceipt(current, receipt, owner);
          current.after = changes.nextAfter;
        });
        continueSync = changes.hasMore;
        if (!changes.hasMore) break;
      }
      for (let sent = 0; sent < 100 && accountId === owner; sent++) {
        const active = await transact(null);
        if (active.paused || active.accountId !== owner) break;
        const local = await transact(owner), entry = local.queue[0];
        if (!entry || entry.failure) break;
        let receipt;
        try { receipt = await request('operations', entry.operation); }
        catch (failure) {
          if (failure.status >= 400 && failure.status < 500 && ![401, 403, 408, 429].includes(failure.status) && failure.code !== 'account_mismatch') {
            await transact(owner, current => {
              const pending = current.queue.find(item => item.operation.operationId === entry.operation.operationId);
              if (pending) pending.failure = failure.message;
            });
          }
          throw failure;
        }
        if (receipt.operationId !== entry.operation.operationId) throw new Error('Acknowledgement does not match this save.');
        await transact(owner, current => applyReceipt(current, receipt, owner));
      }
    });
    if (accountId === owner) {
      const saved = await transact(owner);
      if (accountId === owner) {
        state = saved; render(); $('workspace').hidden = false;
        continueSync ||= !!state.queue.length && !state.queue[0].failure;
      }
    }
    retryDelay = 2000; clearError('sync'); broadcast();
  } catch (failure) {
    if ([401, 403].includes(failure.status) || failure.code === 'account_mismatch') {
      await pauseSession('Session changed or expired. Sign in to the original account to resume its pending work.');
    } else {
      error(`Sync paused: ${failure.message} Pending work stays on this device.`, 'sync');
      if (accountId) {
        const owner = accountId;
        try { const saved = await transact(owner); if (owner === accountId) { state = saved; render(); $('workspace').hidden = false; } }
        catch (storageError) { storageFailure(storageError); }
      }
      retryTimer = setTimeout(() => { void sync(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    }
  } finally {
    syncing = false;
    if (continueSync) retryTimer = setTimeout(() => { void sync(); }, retryDelay);
  }
}
$('sync').onclick = () => { render(); void sync(); };
$('resolve').onclick = guard(async () => {
  const owner = accountId, id = state.queue[0].operation.operationId;
  const reviewed = structuredClone(state.records);
  if (!confirm('Apply this pending edit to the latest server version shown?')) return;
  const saved = await transact(owner, local => {
    const entry = local.queue[0];
    if (entry?.operation.operationId !== id || !entry.receipt) throw new Error('Queue changed; review it again.');
    const mutations = entry.operation.mutations.map(mutation => {
      const record = local.records[key(mutation)];
      if (mutation.action !== 'update' || !record || record.deleted) throw new Error('Deleted or missing records cannot be overwritten. Export your pending text to recover it separately.');
      if (record.version !== reviewed[key(mutation)]?.version) throw new Error('Server version changed again. Review the comparison before applying your edit.');
      return { ...mutation, expectedVersion: record.version };
    });
    local.queue.shift();
    const later = local.queue; local.queue = [];
    enqueue(local, owner, mutations); local.queue.push(...later);
  });
  if (owner !== accountId) return;
  state = saved;
  render(); broadcast(); void sync();
});
$('discard').onclick = guard(async () => {
  if (!confirm('Discard only this failed save and keep the server version? Later queued edits remain and may need review. Export a copy first if needed.')) return;
  const owner = accountId, id = state.queue[0].operation.operationId;
  const saved = await transact(owner, local => {
    if (local.queue[0]?.operation.operationId !== id || !local.queue[0].failure) throw new Error('Queue changed; review it again.');
    local.queue.shift();
  });
  if (owner !== accountId) return;
  state = saved;
  render(); broadcast(); void sync();
});
$('signOut').onclick = guard(async () => {
  await journal();
  await pauseSession('Signed out locally. Pending work remains bound to its original account.');
  location.href = '/.auth/logout?post_logout_redirect_uri=/';
});
channel.onmessage = guard(async () => {
  const saved = await transact(null);
  if (saved.paused || (accountId && saved.accountId !== accountId)) {
    hideAccount(); $('sessionStatus').textContent = 'Account changed in another tab. Sign in or reload to continue.';
  } else if (accountId) {
    const owner = accountId, savedState = await transact(owner);
    if (owner === accountId) { state = savedState; render(); }
  }
});
addEventListener('online', () => { void sync(); });
addEventListener('offline', () => { profileRequest++; $('sessionStatus').textContent = 'Offline — saves remain on this device until you reconnect.'; });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
  if (!document.hidden && navigator.onLine) { $('workspace').hidden = true; void sync(); }
});
addEventListener('focus', () => { render(); if (navigator.onLine) void sync(); });

try {
  await session({ allowOffline: true });
} catch (failure) { error(failure.message); }
syncing = false;
if (accountId) void sync();
