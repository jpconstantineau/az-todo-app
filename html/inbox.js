import { collectionKinds, collectionKind, isCollection, memberships, belongsTo, inCollection, ancestry, refKey, collectionContents, normalizeMembership } from './collection-model.js?v=63';
import { organizer, pickerOptions, selectedRefs, membershipFields, collectionLabel, viewKey, parseRef, drawOutline, checklistMutations, areaMappingMutations } from './collections.js?v=63';
import { PERSONAL, workspaceOf, workspaceRecords, workspaceDraft } from './workspaces.js?v=63';
import { transact, key, projected, enqueue as queueMutations, applyReceipt, captureMutations, rememberEdit, canUndoEdit, undoEdit } from './inbox-store.js?v=63';
import { optionFields, formValues, fillValues, localDate, taskFields, addTaskControls, refreshTaskOptions, defaultsFrom, validateWorkflow, reviewReady, matchesExecutionFilters, readyToExecute } from './inbox-fields.js?v=63';
import { deviceExport, accountExport, readableExport } from './inbox-export.js?v=63';
import { clarificationUI } from './clarification.js?v=63';
import { setupReviews } from './reviews.js?v=63';
import { setupBriefs } from './briefs.js?v=63';
import { setupCaptureExtraction, extractionMutations } from './capture-extraction.js?v=63';
import { setupAgentStatus } from './local-agent.js?v=63';

const $ = id => document.getElementById(id);
setupAgentStatus();
const capture = $('capture'), edit = $('edit');
let accountId = null, state, editing = null, originalInput;
let saving = false, syncing = true, retryTimer, retryDelay = 2000, accountGeneration = 0;
let defaultsEditing = null, recentTaskChange = null;
let exportController;
let selectedWorkspace = PERSONAL, switchingWorkspace = false;
const scopedRecords = () => workspaceRecords(projected(state), selectedWorkspace);
const currentDraft = local => workspaceDraft(local, selectedWorkspace);
function availableWorkspaces() {
  return [{ id: PERSONAL, type: 'workspace', title: 'Personal', version: 0 }, ...Object.values(projected(state)).filter(record => record.type === 'workspace' && !record.deleted)];
}
function renderWorkspaces() {
  const spaces = availableWorkspaces();
  options($('workspaceSelect'), spaces.map(space => ({ ...space, title: space.title + (space.archived ? ' (archived)' : '') })), []);
  if (!spaces.some(space => space.id === selectedWorkspace)) $('workspaceSelect').add(new Option('Unavailable workspace', selectedWorkspace));
  $('workspaceSelect').value = selectedWorkspace;
  document.title = (destination === 'capture' ? 'Capture' : destination === 'lists' ? 'List Workspace' : destination === 'execute' ? 'Execute' : destination === 'reviews' ? 'Review' : 'Process') + ' · ' + $('workspaceSelect').selectedOptions[0].textContent;
  statusText('workspaceStatus', workspaceReadOnly() ? 'This workspace is read-only or deleted. Open Menu → Manage workspaces to unarchive or restore it. Drafts are kept.' : '');
  const records = Object.values(projected(state)).filter(record => record.type === 'workspace');
  $('workspaceEntries').replaceChildren(...records.map(record => {
    const article = document.createElement('article'), heading = document.createElement('h3'), status = document.createElement('p');
    heading.textContent = record.title;
    heading.tabIndex = -1; heading.dataset.focusKey = `workspace:${record.id}:heading`;
    status.id = `workspace-status-${record.id}`; heading.setAttribute('aria-describedby', status.id);
    status.textContent = `${record.deleted ? 'Deleted' : record.archived ? 'Archived' : 'Active'} · ${record.localState || 'Server-confirmed'}`;
    const action = (label, callback) => {
      const control = button(label, async () => {
        const generation = accountGeneration;
        try { await callback(); if (generation === accountGeneration) statusText('workspaceError', ''); }
        catch (failure) { if (generation === accountGeneration) statusText('workspaceError', failure.message); }
      }, `${label} workspace: ${record.title}`, `workspace:${record.id}:${['Archive', 'Unarchive'].includes(label) ? 'archive' : label}`);
      control.dataset.focusFallback = heading.dataset.focusKey;
      return control;
    };
    article.append(heading, status);
    if (record.deleted) article.append(action('Restore', () => saveWorkspace(record, 'restore')));
    else article.append(action('Rename', () => {
      const title = prompt('Workspace name', record.title);
      if (title !== null) return saveWorkspace(record, 'update', { title });
    }), action(record.archived ? 'Unarchive' : 'Archive', () => saveWorkspace(record, 'update', { archived: !record.archived })),
    action('Delete', () => saveWorkspace(record, 'delete')));
    return article;
  }));
}
async function saveWorkspace(record, action, fields) {
  const owner = accountId, generation = accountGeneration;
  if (!owner) return;
  if (fields?.title !== undefined && (!fields.title.trim() || fields.title.length > 200)) throw new Error('Workspace name must be 1–200 characters.');
  const saved = await transact(owner, local => {
    if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before changing a workspace.');
    const current = projected(local)[key(record)];
    if ((current?.version || 0) !== record.version) throw new Error('This workspace changed. Review its latest state and try again.');
    queueMutations(local, owner, [{ type: 'workspace', id: record.id, action, expectedVersion: record.version, ...(fields ? { fields } : {}) }]);
  });
  if (owner !== accountId || generation !== accountGeneration) return;
  state = saved;
  if (action === 'restore' && record.id === selectedWorkspace) { $('workspaceManager').close(); restoreDraft(); }
  render(); broadcast(); void sync();
}
async function switchWorkspace(id) {
  if (!accountId || id === selectedWorkspace) return;
  if (saving || reviews.busy || switchingWorkspace) { $('workspaceSelect').value = selectedWorkspace; throw new Error('Wait for the device save, then switch workspaces.'); }
  if (!availableWorkspaces().some(space => space.id === id)) throw new Error('Workspace unavailable.');
  const owner = accountId, old = selectedWorkspace, snapshot = draft();
  switchingWorkspace = true;
  try {
    const saved = await transact(owner, local => {
      if (!projected(local)['workspace:' + old]?.deleted) Object.assign(workspaceDraft(local, old), snapshot);
      local.selectedWorkspace = id;
    });
    if (owner !== accountId) return;
    editing = defaultsEditing = null;
    $('createdDestination').replaceChildren();
    $('editor').close(); $('defaultsEditor').close(); $('deletedRecords').close();
    extraction.reset(); clarification.hide(); reviews.reset(); briefs.reset();
    state = saved; selectedWorkspace = id;
    render(); restoreDraft();
    if (!document.querySelector('dialog[open]')) $('workspaceSelect').focus();
  } catch (failure) { $('workspaceSelect').value = selectedWorkspace; storageFailure(failure); }
  finally { switchingWorkspace = false; }
}
$('workspaceSelect').onchange = guard(() => switchWorkspace($('workspaceSelect').value));
$('manageWorkspaces').onclick = () => { renderWorkspaces(); showDialog($('workspaceManager')); };
$('closeWorkspaces').onclick = () => $('workspaceManager').close();
$('createWorkspace').onsubmit = event => {
  event.preventDefault();
  const form = event.currentTarget, control = form.querySelector('button');
  if (control.disabled) return;
  const generation = accountGeneration, title = form.elements.title.value;
  control.disabled = true;
  void saveWorkspace({ type: 'workspace', id: crypto.randomUUID(), version: 0 }, 'create', { title }).then(() => {
    if (generation !== accountGeneration) return;
    if (form.elements.title.value === title) form.reset();
    statusText('workspaceError', '');
    if ($('workspaceManager').open && document.activeElement === control) form.elements.title.focus();
  }).catch(failure => { if (generation === accountGeneration) statusText('workspaceError', failure.message); }).finally(() => { control.disabled = false; });
};
edit.elements.workspaceId.onchange = () => {
  const moving = edit.elements.workspaceId.value !== selectedWorkspace;
  options(edit.elements.listId, moving ? [] : Object.values(scopedRecords()).filter(record => record.type === 'list' && !record.deleted), [['', 'No list']]);
  options(edit.elements.projectId, moving ? [] : Object.values(scopedRecords()).filter(record => record.type === 'project' && !record.deleted), [['', 'No project']]);
  if (moving) { edit.elements.listId.value = edit.elements.projectId.value = ''; pickerOptions(edit.elements.collectionRefs, {}, []); } else pickerOptions(edit.elements.collectionRefs, scopedRecords(), selectedRefs(edit.elements.collectionRefs));
  void journal();
};
function enqueue(local, owner, mutations) {
  queueMutations(local, owner, mutations.map(mutation => mutation.action === 'create' && ['item', 'list', 'project', 'review'].includes(mutation.type)
    ? { ...mutation, fields: { ...mutation.fields, workspaceId: mutation.fields.workspaceId || selectedWorkspace } } : mutation));
}
function workspaceReadOnly() {
  const space = projected(state)['workspace:' + selectedWorkspace];
  return selectedWorkspace !== PERSONAL && (!space || space.deleted || space.archived);
}
const dialogOpeners = new Map();
const extraction = setupCaptureExtraction({ journal, showDialog, recovery: storageFailure,
  current: () => accountId && !workspaceReadOnly() ? { ...captureDraft(), accountId, lists: Object.values(scopedRecords()).filter(record => isCollection(record) && !record.deleted).map(record => ({ id: record.type === 'project' ? refKey(record) : record.id, title: collectionLabel(record) })) } : null,
  save: async submitted => {
    const owner = accountId, generation = accountGeneration;
    if (!owner || workspaceReadOnly()) throw new Error('Choose an active workspace to accept these suggestions.');
    if (JSON.stringify(captureDraft()) !== JSON.stringify(submitted.inputCapture)) throw new Error('Capture changed. Your reviewed suggestions are kept; return to capture before starting a new review.');
    const saved = await transact(owner, local => {
      if (JSON.stringify(currentDraft(local).extraction?.draft) !== JSON.stringify(submitted) || JSON.stringify(currentDraft(local).capture) !== JSON.stringify(submitted.inputCapture)) throw new Error('This capture changed in another tab. Reload to inspect the saved draft.');
      const records = projected(local);
      // Stable task IDs survive reviewed edits. A stale tab cannot accept twice,
      // even after the operation is acknowledged or an accepted task is deleted.
      if (Object.values(records).some(record => record.captureId === submitted.id)) throw new Error('This capture was already accepted. Reload to see its tasks.');
      if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before accepting this batch.');
      enqueue(local, owner, extractionMutations(submitted, workspaceRecords(records, selectedWorkspace)));
      currentDraft(local).extraction = { ...currentDraft(local).extraction, draft: null, clock: null, sourceText: '' }; currentDraft(local).capture = {};
    });
    if (owner !== accountId || generation !== accountGeneration) throw new Error('Account changed; the batch remains with its original account.');
    state = saved; capture.reset(); originalInput = undefined; $('previewHelp').hidden = true;
    clearError(); render(); broadcast(); void sync();
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  const menu = document.activeElement.closest('details');
  if (menu?.open && (menu.id === 'connection' || menu.classList.contains('task-menu') || menu.classList.contains('responsive-menu'))) {
    menu.open = false; menu.querySelector('summary').focus(); event.preventDefault();
  }
});
const briefs = setupBriefs({ records: () => accountId ? scopedRecords() : {}, journal, showDialog, save: async (mutation, next) => {
  const owner = accountId, generation = accountGeneration;
  if (!owner) throw new Error('Sign in to save this brief.');
  const saved = await transact(owner, local => {
    if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before saving this brief. Your draft is kept.');
    const records = projected(local), current = records[key(mutation)];
    if (current?.deleted || (current?.version || 0) !== mutation.expectedVersion) throw new Error('This revision changed. Close and reopen the brief to review its latest state.');
    enqueue(local, owner, [mutation]);
    currentDraft(local).brief = next;
  }).catch(failure => { if (owner === accountId) storageFailure(failure); throw failure; });
  if (owner !== accountId || generation !== accountGeneration) throw new Error('Account changed; the save stays with its original account.');
  state = saved; render(); broadcast(); void sync();
} });
const clarification = clarificationUI({ records: () => scopedRecords(), journal, save: saveClarification, showDialog });
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
    currentDraft(local).clarification = next;
  }).catch(failure => { if (owner === accountId) storageFailure(failure); throw failure; });
  if (owner !== accountId) return false;
  state = saved; render(); broadcast(); void sync(); return true;
}
let destination = 'capture';
const emptyNavigation = () => ({ work: { view: 'inbox', status: '' }, lists: { view: '', status: '' }, execute: { kind: 'list', view: '' } });
let navigation = emptyNavigation();
const reviews = setupReviews({ current: () => accountId ? state : null, records: scopedRecords, journal,
  edit: record => {
    if (editing && (key(editing) !== key(record) || editing.version !== record.version) && JSON.stringify(formValues(edit)) !== JSON.stringify(editing.initialFields)) {
      showDialog($('editor')); error('Finish saving this edit before editing another record. Your draft is still here.');
      edit.elements.title.focus(); return;
    }
    openEditor(record);
  },
  clarify: record => clarification.open(record), addAction: addContextItem, save: async mutations => {
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
capture.elements.projectId.closest('label').remove();
capture.elements.areas.closest('label').remove();
const editOrganizer = organizer($('editOrganizer'), {}, []);
const primaryMemberships = document.createElement('details'), primarySummary = document.createElement('summary');
primarySummary.textContent = 'Primary memberships (defaults and older apps)'; primaryMemberships.append(primarySummary, $('editListLabel'), edit.elements.projectId.closest('label')); $('editOrganizer').append(primaryMemberships);
edit.elements.projectId.closest('label').firstChild.textContent = 'Primary project (optional)';
editOrganizer.onchange = () => {
  const fields = membershipFields(selectedRefs(editOrganizer), { listId: edit.elements.listId.value, projectId: edit.elements.projectId.value });
  edit.elements.listId.value = fields.listId || ''; edit.elements.projectId.value = fields.projectId || ''; refreshOptions(); void journal();
};
for (const type of ['list', 'project']) edit.elements[type + 'Id'].addEventListener('change', () => {
  const old = { ...editing?.initialFields, collectionRefs: selectedRefs(editOrganizer) };
  const fields = { [type + 'Id']: edit.elements[type + 'Id'].value || null };
  pickerOptions(editOrganizer, scopedRecords(), normalizeMembership({ ...old, ...fields }, old, fields).collectionRefs); void journal();
});
edit.elements.kind.replaceChildren(...Object.entries(collectionKinds).map(([kind, label]) => new Option(label, kind)));
edit.elements.kind.onchange = () => {
  if (!editing || editing.version) return;
  editing.type = edit.elements.kind.value === 'project' ? 'project' : 'list';
  $('editProjectLifecycle').hidden = editing.type !== 'project';
  $('editOutcomeLabel').hidden = editing.type !== 'project'; edit.elements.outcome.required = editing.type === 'project'; void journal();
};
capture.elements.status.closest('label').hidden = true;
$('includeNested').onchange = () => { navigation.lists.nested = $('includeNested').checked; render(); void journal(); };

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
const utilityForm = $('collectionUtilityForm');
function utilityDraft() {
  return { ...formValues(utilityForm), entries: [...utilityForm.elements.entries.selectedOptions].map(option => option.value), next: utilityForm.elements.next.checked, source: utilityForm.dataset.source || '' };
}
function restoreUtility(saved = {}) {
  utilityForm.reset(); utilityForm.dataset.source = saved.source || '';
  for (const name of ['title', 'mode', 'tag', 'target']) if (saved[name] !== undefined) {
    const input = utilityForm.elements[name];
    if (input.tagName === 'SELECT' && ![...input.options].some(option => option.value === saved[name])) input.add(new Option(saved[name], saved[name]));
    input.value = saved[name];
  }
  utilityForm.elements.next.checked = !!saved.next;
  utilityForm.elements.entries.replaceChildren(...(saved.entries || []).map(id => new Option(id, id, true, true)));
  statusText('collectionUtilityStatus', '');
}
function renderCollectionUtilities(context) {
  const all = scopedRecords(), form = utilityForm, selected = utilityDraft();
  $('checklistFields').hidden = form.elements.mode.value !== 'checklist'; $('areaMappingFields').hidden = form.elements.mode.value !== 'area';
  const source = context && collectionKind(context) === 'reference' ? key(context) : '';
  const entries = Object.values(all).filter(item => source && item.type === 'item' && !item.deleted && belongsTo(item, context));
  form.elements.entries.replaceChildren(...entries.map(item => new Option(item.title, item.id, false, source === selected.source && selected.entries.includes(item.id))));
  form.dataset.source = source;
  const tags = [...new Set(Object.values(all).filter(item => item.type === 'item' && !item.deleted).flatMap(item => item.areas || []))];
  options(form.elements.tag, tags.map(tag => ({ id: tag, title: tag })), [['', 'Choose an area tag']]);
  options(form.elements.target, Object.values(all).filter(record => isCollection(record) && !record.deleted && collectionKind(record) === 'area').map(record => ({ id: key(record), title: record.title })), [['', 'Create a new Area']]);
  form.querySelector('button').disabled = saving || workspaceReadOnly();
}
utilityForm.addEventListener('input', () => { void journal(); });
utilityForm.elements.mode.onchange = () => { render(); void journal(); };
utilityForm.onsubmit = event => {
  event.preventDefault();
  if (saving || !accountId || workspaceReadOnly()) return;
  const owner = accountId, generation = accountGeneration, submitted = utilityDraft(), workspaceId = selectedWorkspace;
  saving = true; const controls = [...utilityForm.elements]; controls.forEach(control => { control.disabled = true; });
  void (async () => {
    try {
      let result;
      const saved = await transact(owner, local => {
        if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before organizing more items.');
        const records = workspaceRecords(projected(local), workspaceId);
        if (submitted.mode === 'checklist') {
          const source = records[submitted.source];
          if (!source) throw new Error('Choose a reference list first.');
          const items = submitted.entries.map(id => records['item:' + id]);
          if (items.some(item => !item)) throw new Error('An entry is unavailable. Select entries again.');
          result = { mutations: checklistMutations(source, items, submitted.title, submitted.next), remaining: 0 };
        } else result = areaMappingMutations(records, submitted.tag, submitted.target ? parseRef(submitted.target) : null, submitted.title, workspaceId);
        enqueue(local, owner, result.mutations);
        currentDraft(local).collectionUtility = result.ref ? { ...submitted, target: refKey(result.ref), title: '' } : { mode: 'checklist' };
      });
      if (owner !== accountId || generation !== accountGeneration) return;
      state = saved; restoreUtility(currentDraft(state).collectionUtility); render(); broadcast(); void sync();
      statusText('collectionUtilityStatus', submitted.mode === 'area' ? `Batch saved on device. ${result.remaining} item(s) remain; save again to continue.` : 'New checklist saved on device. The reference list is unchanged.');
    } catch (failure) { if (owner === accountId) { statusText('collectionUtilityStatus', failure.message); void journal(); } }
    finally { saving = false; controls.forEach(control => { control.disabled = false; }); if (owner === accountId) utilityForm.querySelector('button').disabled = workspaceReadOnly(); }
  })();
};
const channel = new BroadcastChannel('todo-inbox');
const broadcast = () => channel.postMessage('changed');
function statusText(id, text) {
  // Replacing identical live-region text can announce it again on every keystroke/render.
  if ($(id).textContent !== text) $(id).textContent = text;
}
function connectionStatus() {
  if (!accountId || !state) return;
  const needsAttention = state.queue.some(entry => entry.failure) || !$('error').hidden;
  $('saveStatus').dataset.state = !navigator.onLine ? 'offline' : needsAttention ? 'error' : state.queue.length || syncing ? 'pending' : 'confirmed';
  const label = !navigator.onLine ? 'Working offline' : needsAttention ? 'Save needs attention' : state.queue.length ? `${state.queue.length} save(s) pending` : syncing ? 'Syncing with cloud' : 'Saved to cloud';
  $('saveStatus').title = label;
  statusText('connectionLabel', label);
}
function error(message, kind = 'local') {
  $('error').hidden = false; statusText('error', message); $('error').dataset.kind = kind;
  if ($('editor').open) { $('editError').hidden = false; statusText('editError', message); }
  if ($('defaultsEditor').open) { $('defaultsError').hidden = false; statusText('defaultsError', message); }
  if ($('deletedRecords').open) statusText('deletedError', message);
  connectionStatus();
}
function clearError(kind) {
  if (!kind || $('error').dataset.kind === kind) { $('error').hidden = true; $('editError').hidden = true; }
  connectionStatus();
}
function captureDraft() {
  return { ...formValues(capture), ...(originalInput === undefined ? {} : { original: originalInput }) };
}
function hasEditDraft() {
  return editing && (editing.version === 0 || JSON.stringify(formValues(edit)) !== JSON.stringify(editing.initialFields));
}
function draft() {
  return { workspaceId: selectedWorkspace, capture: captureDraft(), edit: hasEditDraft() ? { ...editing, fields: formValues(edit) } : null, editOpen: $('editor').open,
    defaults: defaultsEditing ? { ...defaultsEditing, values: formValues($('defaultsForm')) } : null,
    defaultsOpen: $('defaultsEditor').open, clarification: clarification.snapshot(), brief: briefs.snapshot(),
    collectionUtility: utilityDraft(), day: $('day').value, navigation: structuredClone(navigation), review: reviews.draft(), extraction: extraction.snapshot() };
}
function storageFailure(failure) {
  error(`Could not save on this device: ${failure.message}. Your text has been kept. Copy or export it before leaving.`);
  statusText('draftStatus', 'Not saved on device');
  $('recovery').hidden = false;
  $('recoveryText').value = JSON.stringify({ accountId, draft: draft(), localCopy: state }, null, 2);
  $('editor').close(); // Make the recovery copy outside the modal reachable.
  $('defaultsEditor').close();
  clarification.close();
  briefs.close();
  extraction.close();
}
function guard(action) {
  return (...args) => Promise.resolve().then(() => action(...args)).catch(failure => error(failure.message));
}
async function journal() {
  if (!accountId || switchingWorkspace || projected(state)['workspace:' + selectedWorkspace]?.deleted) return false;
  const owner = accountId, snapshot = draft();
  try {
    const saved = await transact(owner, local => { Object.assign(currentDraft(local), snapshot); });
    if (owner === accountId) { state = saved; statusText('draftStatus', ''); statusText('clarifyDraftStatus', 'Draft saved on device; not accepted.'); }
    return owner === accountId;
  } catch (failure) { if (owner === accountId) storageFailure(failure); return false; }
}
function options(select, lists, first, keepMissing = false) {
  const selected = select.value;
  select.replaceChildren(...first.map(([value, text]) => new Option(text, value)), ...lists.map(list => new Option(list.title, list.id)));
  if (keepMissing && selected && ![...select.options].some(option => option.value === selected)) select.add(new Option('Unavailable destination — choose another or clear', selected));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}
function restoreDraft() {
  capture.reset(); edit.reset(); editing = null; originalInput = undefined;
  const saved = projected(state)['workspace:' + selectedWorkspace]?.deleted ? {} : currentDraft(state);
  fillValues(capture, { ...saved.capture, listId: saved.capture?.projectId ? `project:${saved.capture.projectId}` : saved.capture?.listId });
  originalInput = saved.capture?.original;
  extraction.restore(saved.extraction); restoreUtility(saved.collectionUtility);
  $('previewHelp').hidden = originalInput === undefined;
  navigation = emptyNavigation();
  // Preserve the former review filter when upgrading an existing device draft.
  Object.assign(navigation.work, saved.navigation?.work || { view: saved.view || 'inbox', status: saved.status || '' });
  Object.assign(navigation.lists, saved.navigation?.lists || {});
  Object.assign(navigation.execute, saved.navigation?.execute || {});
  $('day').value = saved.day ?? localDate(new Date().toISOString()).slice(0, 10);
  workspace(false);
  // Keep unfinished list creation available through New list without opening it on arrival.
  if (saved.edit) openEditor(saved.edit, false, saved.editOpen === true && !(saved.edit.type === 'list' && saved.edit.version === 0));
  else $('editor').close();
  if (saved.defaults) openDefaults(saved.defaults, false, saved.defaultsOpen !== false);
  refreshOptions(); render();
  reviews.restore(saved.review);
  clarification.restore(saved.clarification);
  briefs.restore(saved.brief);
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
  const expandedActions = new Set([...document.querySelectorAll('.task-menu[open]')].map(menu => menu.dataset.recordKey));
  const records = Object.values(scopedRecords()).filter(record => !record.deleted);
  const lists = records.filter(record => record.type === 'list');
  const projects = records.filter(record => record.type === 'project');
  renderWorkspaces();
  // A conflict can replace the optimistic record with a different record at the same version.
  if (state.queue.some(entry => entry.failure)) recentTaskChange = null;
  const recent = recentTaskChange?.owner === accountId && recentTaskChange.workspace === selectedWorkspace
    ? records.find(record => key(record) === recentTaskChange.key && record.version === recentTaskChange.version) : null;
  const canUndoTask = !!recent && !workspaceReadOnly() && !state.queue.some(entry => entry.failure);
  $('recentTaskChange').hidden = !canUndoTask;
  statusText('recentTaskChangeStatus', canUndoTask ? `${recent.status === 'completed' ? 'Completed' : 'Reopened'} “${recent.title}”. Saved on device.` : '');
  $('undoTaskChange').onclick = guard(async () => {
    const current = scopedRecords()[recentTaskChange?.key];
    if (!current || current.version !== recentTaskChange.version || state.queue.some(entry => entry.failure)) throw new Error('This task changed. Review its latest state before undoing.');
    await updateRecord(current, current.workflowBeforeTransition);
  });
  const undoAvailable = !workspaceReadOnly() && canUndoEdit(state) && workspaceOf(projected(state)[key(state.undoEdit)], projected(state)) === selectedWorkspace;
  $('undoEdit').disabled = !undoAvailable;
  statusText('undoEditStatus', state.undoEdit
    ? undoAvailable ? `Undo edit to “${state.undoEdit.title}” until ${new Date(state.undoEdit.expiresAt).toLocaleString()}.`
      : 'The last edit expired, its record changed, or a save needs attention.'
    : 'No editor save to undo on this device.');
  options(capture.elements.listId, [...lists.map(record => ({ ...record, title: collectionLabel(record) })), ...projects.map(record => ({ id: refKey(record), title: collectionLabel(record) }))], [['', 'No list']], true);
  extraction.refreshLists();
  const moving = editing?.type === 'item' && edit.elements.workspaceId.value && edit.elements.workspaceId.value !== selectedWorkspace;
  options(edit.elements.listId, moving ? [] : lists, [['', 'No list']]);
  options(edit.elements.projectId, moving ? [] : projects, [['', 'No project']], !moving);
  const listMode = destination === 'lists';
  const filters = navigation[listMode ? 'lists' : 'work'];
  options($('view'), [...lists.map(record => ({ ...record, title: collectionLabel(record) })), ...projects.map(project => ({ id: `project:${project.id}`, title: collectionLabel(project) }))],
    listMode ? [['', 'Choose a list']] : [['inbox', 'Inbox (unprocessed)'], ['all', 'All items'], ['unfiled', 'No list'], ['day', 'Planned day']]);
  $('view').value = [...$('view').options].some(option => option.value === filters.view) ? filters.view : listMode ? '' : 'inbox';
  filters.view = $('view').value;
  $('collectionBrowser').hidden = $('collectionUtilities').hidden = !listMode;
  $('includeNested').checked = !!filters.nested;
  if (listMode) drawOutline($('collectionOutline'), scopedRecords(), record => { navigation.lists.view = viewKey(record); render(); void journal(); });
  if (editing?.type === 'item') pickerOptions(editOrganizer, moving ? {} : scopedRecords(), selectedRefs(editOrganizer));
  refreshOptions();
  filters.statuses = Array.isArray(filters.statuses) ? filters.statuses.filter(status => typeof status === 'string') : [];
  const statuses = [...new Set(['inbox', 'next', 'waiting', 'deferred', 'reference', 'completed', 'dropped', ...(userDefaults().statuses || []), ...lists.flatMap(list => list.defaults?.statuses || []), ...records.filter(record => record.type === 'item').map(record => record.status), ...filters.statuses])];
  options($('statusFilter'), statuses.map(status => ({ id: status, title: status === 'completed' ? 'Completed' : status })), [['', 'Incomplete items'], ['@all', 'All statuses'], ['@review-ready', 'Ready for review'], ['@include', 'Include statuses…'], ['@exclude', 'Exclude statuses…']]);
  $('statusFilter').value = [...$('statusFilter').options].some(option => option.value === filters.status) ? filters.status : '';
  filters.status = $('statusFilter').value;
  const contexts = [...new Set([...(userDefaults().contexts || []), ...lists.flatMap(list => list.defaults?.contexts || []), ...records.filter(record => record.type === 'item').flatMap(record => record.contexts || []), ...(filters.context?.startsWith('context:') ? [filters.context.slice(8)] : [])])];
  options($('contextFilter'), contexts.map(context => ({ id: `context:${context}`, title: context })), [['', 'Any context'], ['@none', 'No context']]);
  for (const [field, id] of [['context', 'contextFilter'], ['minutes', 'timeFilter'], ['energy', 'energyFilter']]) {
    $(id).value = filters[field] || '';
    filters[field] = $(id).value;
  }
  const executionCount = listMode ? [filters.context, filters.minutes, filters.energy].filter(Boolean).length : 0;
  $('executionSummary').textContent = `Context, time & energy${executionCount ? ` (${executionCount} active)` : ''}`;
  const customStatuses = ['@include', '@exclude'].includes(filters.status);
  $('statusSelection').hidden = !customStatuses;
  $('statusSelectionLegend').textContent = filters.status === '@exclude' ? 'Hide selected statuses' : 'Show selected statuses';
  $('statusSelectionHelp').textContent = filters.status === '@exclude'
    ? 'Hide items matching any checked status. With none checked, show all statuses.'
    : 'Show items matching any checked status. With none checked, show no items.';
  $('statusChoices').replaceChildren(...(customStatuses ? statuses.map(status => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.value = status; input.checked = filters.statuses.includes(status);
    input.dataset.focusKey = `status-filter:${status}`;
    label.append(input, document.createTextNode(status === 'completed' ? 'Completed' : status));
    return label;
  }) : []));
  statusText('syncStatus', state.queue.length ? `${state.queue.length} save(s) on device — ${state.queue.some(entry => entry.failure) ? 'failed / needs attention' : 'pending server confirmation'}.` : 'All saved work is server-confirmed.');
  connectionStatus();
  $('lists').replaceChildren(...lists.filter(list => listMode && list.id === filters.view).flatMap(list => [titleButton(list, `Edit list: ${list.title}`), button('Defaults', () => openDefaults(list), `Defaults: ${list.title}`, `${key(list)}:defaults`), deleteButton(list)]));
  const view = $('view').value;
  $('dayLabel').hidden = view !== 'day';
  const project = projects.find(project => view === `project:${project.id}`);
  const context = project || lists.find(list => list.id === view);
  $('collectionBreadcrumbs').textContent = context ? ancestry(context, scopedRecords()).reverse().map(ref => scopedRecords()[refKey(ref)]?.title || 'Unavailable parent').join(' / ') : 'Choose a list, project, area or role.';
  $('collectionChildren').replaceChildren(...(listMode && context ? records.filter(record => isCollection(record) && record.parentRef && refKey(record.parentRef) === key(context)).map(child => button(collectionLabel(child), () => { navigation.lists.view = viewKey(child); render(); void journal(); }, `Open ${collectionLabel(child)}`, `child:${key(child)}`)) : []));
  renderCollectionUtilities(context);
  $('addContextItem').hidden = !context;
  $('addContextItem').disabled = workspaceReadOnly();
  $('addContextItem').textContent = project ? 'Add next action' : 'Add item';
  $('addContextItem').onclick = guard(() => addContextItem(context));
  $('projectOutcome').hidden = !project;
  $('projectOutcome').textContent = project ? `Project status: ${project.status || 'active'} · Desired outcome: ${project.outcome} · ${records.filter(record => record.type === 'item' && record.status === 'next' && belongsTo(record, project)).length} next action(s)` : '';
  $('projectActions').replaceChildren(...(project ? [titleButton(project, `Edit project: ${project.title}`), button('Brief', () => briefs.open(project), `Brief ${project.title}`, `${key(project)}:brief`), deleteButton(project)] : []));
  $('items').replaceChildren(...records.filter(record => {
    if (record.type !== 'item') return false;
    if (listMode && !matchesExecutionFilters(record, filters)) return false;
    if (collectionKind(context || { type: 'list' }) !== 'reference' && !filters.status && ['completed', 'reference'].includes(record.status)) return false;
    if (view === 'day' && record.status === 'reference') return false;
    if (customStatuses) {
      const selected = filters.statuses.includes(record.status);
      if (filters.status === '@include' ? !selected : selected) return false;
    } else if (filters.status && filters.status !== '@all' && (filters.status === '@review-ready' ? !reviewReady(record) : record.status !== filters.status)) return false;
    if (view === 'all') return true;
    if (view === 'inbox') return record.status === 'inbox';
    if (view === 'unfiled') return !memberships(record).some(ref => ref.type === 'list');
    if (view === 'day') return !!$('day').value && record.plannedDay === $('day').value;
    return !!context && inCollection(record, context, scopedRecords(), listMode && !!filters.nested);
  }).map(record => {
    const article = document.createElement('article'); article.dataset.id = record.id;
    const title = document.createElement('h3'); title.append(titleButton(record));
    const notes = document.createElement('p'); notes.className = 'notes'; notes.textContent = record.description;
    const metadata = document.createElement('p'); metadata.className = 'notes';
    metadata.textContent = [...(record.contexts || []), ...(record.areas || []), record.energy, record.timeRequired, record.priority].filter(Boolean).join(' · ');
    for (const ref of memberships(record)) metadata.append(` · ${scopedRecords()[refKey(ref)] ? collectionLabel(scopedRecords()[refKey(ref)]) : 'Unavailable collection: ' + refKey(ref)}`);
    if (record.plannedDay) metadata.append(` · Planned: ${record.plannedDay}`);
    if (record.dueDateUtc) { const time = document.createElement('time'); time.dateTime = record.dueDateUtc; time.textContent = ` Due ${new Date(record.dueDateUtc).toLocaleString()}`; metadata.append(time); }
    for (const [name, label] of [['dueDate', 'Deadline'], ['waitingOn', 'Waiting for'], ['startDate', 'Deferred until'], ['startDateUtc', 'Deferred until'], ['reviewDate', 'Review on'], ['reviewDateUtc', 'Review on']]) {
      if (record[name]) metadata.append(` · ${label}: ${name.endsWith('Utc') ? new Date(record[name]).toLocaleString() : record[name]}`);
    }
    if (reviewReady(record)) metadata.append(' · Ready for review — choose Next or set a new date');
    const status = document.createElement('p'); status.className = 'record-state'; status.dataset.pending = String(!!record.localState);
    status.textContent = [record.status || 'inbox', record.localState].filter(Boolean).join(' · ');
    const actions = document.createElement('div'); actions.className = 'actions';
    const action = record.status === 'completed' ? 'Reopen' : 'Complete';
    const complete = button(record.status === 'completed' ? '↶' : '✓', () => updateRecord(record, { status: record.status === 'completed' ? record.statusBeforeCompletion || 'next' : 'completed' }), `${action} ${record.title}`, `${key(record)}:complete`);
    complete.className = 'icon-button'; complete.title = action;
    const menu = document.createElement('details'); menu.className = 'task-menu responsive-menu'; menu.dataset.recordKey = key(record);
    menu.open = expandedActions.has(key(record));
    const summary = document.createElement('summary'); summary.textContent = '•••'; summary.setAttribute('aria-label', `More actions for ${record.title}`); summary.title = 'More actions'; summary.dataset.focusKey = `${key(record)}:more`;
    actions.append(button('Clarify', () => clarification.open(record), `Clarify ${record.title}`, `${key(record)}:clarify`));
    if (record.status !== 'reference') actions.append(button('Brief', () => briefs.open(record), `Brief ${record.title}`, `${key(record)}:brief`));
    actions.append(deleteButton(record));
    if (record.workflowBeforeTransition) actions.append(button('Undo state change', () => updateRecord(record, record.workflowBeforeTransition), `Undo state change ${record.title}`, `${key(record)}:undo`));
    menu.append(summary, actions);
    const heading = document.createElement('div'); heading.className = 'task-heading'; heading.append(title);
    if (record.status !== 'reference') heading.append(complete);
    heading.append(menu);
    article.append(heading, notes, metadata, status); return article;
  }));
  if (!$('items').childElementCount) $('items').textContent = listMode && !view
    ? (lists.length ? 'Choose a list to see its items and manage its details.' : 'No lists yet. Create a list, or use Capture without one.')
    : executionCount ? 'No items match this view. Reset context, time & energy to broaden your choices, or change View or Status.'
    : view === 'inbox' ? 'No unprocessed captures match this view. Check Status for additional filters, or use Capture to add work.'
    : context ? `No items match this view. Choose Completed or All statuses to see finished work, or use ${project ? 'Add next action' : 'Add item'} to add work here.`
    : 'No items match this view. Choose Completed or All statuses to see finished work, or use Capture to add work.';
  const failed = state.queue[0]?.failure ? state.queue[0] : null;
  $('failure').hidden = !failed;
  if (failed) {
    $('failureMessage').textContent = failed.failure;
    const describe = record => !record ? 'No server record' : record.deleted ? 'Deleted on server' :
      [['content', 'Brief content'], ['subjectType', 'Brief source type'], ['subjectId', 'Brief source ID'], ['sourceVersion', 'Brief source version'], ['previousBriefId', 'Previous brief revision'], ['step', 'Clarification step'], ['answers', 'Accepted answers / unknowns'], ['proposal', 'Unaccepted proposal'], ['reviewKind', 'Review kind'], ['included', 'Included records'], ['decisions', 'Decision history'], ['decisionHeads', 'Latest decisions'], ['decisionCount', 'New history entries'], ['reviewId', 'Review'], ['choice', 'Decision'], ['before', 'Prior workflow'], ['changes', 'Workflow changes'], ['collectionRefs', 'Memberships'], ['parentRef', 'Parent'], ['kind', 'Kind'], ['title', 'Title'], ['description', 'Notes'], ['outcome', 'Desired outcome'], ['projectId', 'Project ID'], ['plannedDay', 'Planned day'], ['status', 'Status'], ['waitingOn', 'Waiting for'], ['startDate', 'Deferred until'], ['startDateUtc', 'Deferred until (UTC)'], ['reviewDate', 'Review on'], ['reviewDateUtc', 'Review on (UTC)'], ['dueDate', 'Deadline'], ['listId', 'List'], ['defaults', 'Defaults'], ['dueDateUtc', 'Due'], ['contexts', 'Contexts'], ['areas', 'Areas'], ['energy', 'Energy'], ['timeRequired', 'Time required'], ['priority', 'Priority']]
        .filter(([field]) => field in record).map(([field, label]) => `${label}: ${field === 'listId' ? lists.find(list => list.id === record[field])?.title || 'No list / unavailable list' : typeof record[field] === 'object' ? JSON.stringify(record[field], null, 2) : record[field]}`).join('\n');
    $('comparison').textContent = failed.operation.mutations.map(mutation =>
      `Pending ${mutation.type}\n${describe(mutation.fields)}\n\nServer version\n${describe(state.records[key(mutation)])}`).join('\n\n——\n\n');
    $('resolve').hidden = !failed.receipt || failed.operation.mutations.some(mutation => ['review', 'brief'].includes(mutation.type) || mutation.action !== 'update' || !state.records[key(mutation)] || state.records[key(mutation)].deleted);
    $('discard').textContent = failed.receipt ? 'Use server version for this save' : 'Remove this rejected save';
  }
  reviews.render();
  briefs.render();
  renderDeleted();
  renderEditorDraft();
  const readOnly = workspaceReadOnly();
  const execute = navigation.execute;
  const kinds = $('executeKinds');
  const availableKinds = new Set(['list', 'project', 'checklist', ...lists.map(collectionKind)]);
  for (const control of kinds.querySelectorAll('[data-execute-kind]')) {
    if (!availableKinds.has(control.dataset.executeKind)) control.remove();
  }
  for (const [kind, label] of Object.entries(collectionKinds)) {
    if (!availableKinds.has(kind) || kinds.querySelector(`[data-execute-kind="${kind}"]`)) continue;
    const control = document.createElement('button');
    control.type = 'button'; control.dataset.executeKind = kind; control.textContent = label;
    kinds.append(control);
  }
  if (!availableKinds.has(execute.kind)) { execute.kind = 'list'; execute.view = ''; }
  for (const control of kinds.querySelectorAll('[data-execute-kind]')) control.setAttribute('aria-pressed', String(control.dataset.executeKind === execute.kind));
  const executeCollections = (execute.kind === 'project' ? projects : lists.filter(list => collectionKind(list) === execute.kind));
  options($('executeList'), executeCollections.map(record => ({ id: viewKey(record), title: record.title })), [['', `Choose a ${execute.kind}`]]);
  $('executeList').value = executeCollections.some(record => viewKey(record) === execute.view) ? execute.view : '';
  $('executeList').setAttribute('aria-label', `Choose ${collectionKinds[execute.kind]}`);
  execute.view = $('executeList').value;
  options($('executeContextFilter'), contexts.map(context => ({ id: `context:${context}`, title: context })), [['', 'Any context'], ['@none', 'No context']]);
  for (const [field, id] of [['context', 'executeContextFilter'], ['minutes', 'executeTimeFilter'], ['energy', 'executeEnergyFilter']]) {
    $(id).value = execute[field] || '';
    execute[field] = $(id).value;
  }
  const executeFilterCount = [execute.context, execute.minutes, execute.energy].filter(Boolean).length;
  $('executeFilterSummary').textContent = `Context, time & energy${executeFilterCount ? ` (${executeFilterCount} active)` : ''}`;
  const executeCollection = executeCollections.find(record => viewKey(record) === execute.view);
  const executeItems = records.filter(record => executeCollection && record.type === 'item' && belongsTo(record, executeCollection));
  const readyItems = executeItems.filter(readyToExecute);
  $('executeItems').replaceChildren(...readyItems.filter(record => matchesExecutionFilters(record, execute)).map(record => {
    const article = document.createElement('article'); article.className = 'execute-item'; article.dataset.id = record.id;
    const checkLabel = document.createElement('label'); checkLabel.className = 'execute-check';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.disabled = readOnly;
    checkbox.setAttribute('aria-label', `Complete ${record.title}`); checkbox.dataset.focusKey = `${key(record)}:execute-complete`;
    checkbox.addEventListener('change', guard(async () => {
      checkbox.disabled = true;
      try { await updateRecord(record, { status: 'completed' }); }
      finally { if (checkbox.isConnected) { checkbox.checked = false; checkbox.disabled = !accountId || workspaceReadOnly(); } }
    }));
    const title = titleButton(record); title.dataset.focusKey = `${key(record)}:execute-edit`; title.disabled = readOnly;
    checkLabel.append(checkbox); article.append(checkLabel, title); return article;
  }));
  if (!$('executeItems').childElementCount) $('executeItems').textContent = execute.view
    ? readyItems.length && executeFilterCount ? 'No ready items match these filters. Reset context, time & energy to see more.' : `No ready items in this ${execute.kind}. Inspect saved work in List Workspace, or choose another ${execute.kind}.`
    : executeCollections.length ? `Choose a ${execute.kind} to start working through its items.` : `No ${execute.kind}s yet. Create one in List Workspace.`;
  $('capture').hidden = !!projected(state)['workspace:' + selectedWorkspace]?.deleted;
  $('captureAI').hidden = readOnly;
  if (readOnly) { extraction.suspend(); $('editor').close(); $('defaultsEditor').close(); clarification.close(); briefs.close(); }
  $('captureWorkspaceFields').disabled = readOnly;
  $('reviewWorkspaceFields').disabled = readOnly;
  for (const id of ['newList', 'newProject']) $(id).disabled = readOnly;
  if (readOnly) document.querySelectorAll('#items button, #lists button, #projectActions button, #deletedItems button').forEach(control => { control.disabled = true; });
  if (!focused.isConnected || (focused !== document.body && !focused.getClientRects().length)) restoreFocus(focused);
}
function deleteButton(record) {
  return button('Delete', async () => {
    const linked = record.type === 'list' ? Object.values(scopedRecords()).filter(item => item.type === 'item' && !item.deleted && belongsTo(item, record)) : [];
    const pending = linked.filter(item => item.status !== 'completed').length;
    if (pending && !confirm(`Delete “${record.title}”? This list has ${pending} uncompleted item${pending === 1 ? '' : 's'}. Its ${linked.length} linked item${linked.length === 1 ? '' : 's'} will also be marked deleted. Cancel to review the pending items.`)) return;
    await changeDeletion(record, 'delete', linked.map(item => `${key(item)}:${item.version}`).sort());
  }, `Delete ${record.type}: ${record.title}`, `${key(record)}:delete`);
}
function renderDeleted() {
  statusText('deletedStatus', state.queue.length ? 'Device changes are pending server confirmation. Check Sync status for failures.' : 'All saved work is server-confirmed.');
  const deleted = Object.values(scopedRecords()).filter(record => record.deleted && ['item', 'list', 'project'].includes(record.type));
  $('deletedItems').replaceChildren(...deleted.map(record => {
    const article = document.createElement('article'), title = document.createElement('h3'), status = document.createElement('p');
    title.textContent = `${record.type}: ${record.title}`;
    status.textContent = record.localState || 'Deletion server-confirmed';
    article.append(title, status, button('Restore', () => changeDeletion(record, 'restore'), `Restore ${record.type}: ${record.title}`, `${key(record)}:restore`));
    return article;
  }));
  if (!deleted.length) $('deletedItems').textContent = 'No deleted items, lists or projects on this device. Sync to retrieve changes from other devices.';
}
async function changeDeletion(record, action, linkedSnapshot = []) {
  const owner = accountId, generation = accountGeneration;
  if (!owner) return;
  const saved = await transact(owner, local => {
    if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before deleting or restoring records.');
    const records = projected(local), current = records[key(record)];
    if (!current || current.version !== record.version || !!current.deleted !== (action === 'restore')) throw new Error('This record changed. Review its latest state before trying again.');
    if (action === 'delete' && record.type === 'list') {
      const linked = Object.values(records).filter(item => item.type === 'item' && !item.deleted && belongsTo(item, record));
      if (JSON.stringify(linked.map(item => `${key(item)}:${item.version}`).sort()) !== JSON.stringify(linkedSnapshot)) throw new Error('This list’s items changed. Review them before deleting the list.');
      const deletions = linked.map(item => ({ type: 'item', id: item.id, action: 'delete', expectedVersion: item.version }));
      while (deletions.length > 19) enqueue(local, owner, deletions.splice(0, 20));
      enqueue(local, owner, [...deletions, { type: 'list', id: record.id, action, expectedVersion: record.version }]);
      return;
    }
    if (action === 'delete' && record.type === 'project' && Object.values(records).some(item => collectionContents(item, record))) {
      throw new Error(`Move or delete this ${record.type}'s items and unlink child collections before deleting it.`);
    }
    if (action === 'restore' && record.type === 'item') {
      for (const { type, id } of memberships(current)) {
        const parent = records[`${type}:${id}`];
        if (id && (!parent || parent.deleted)) throw new Error(`Restore this item's ${type} first, then restore the item.`);
      }
    }
    enqueue(local, owner, [{ type: record.type, id: record.id, action, expectedVersion: record.version }]);
  });
  if (owner !== accountId || generation !== accountGeneration) return;
  state = saved; clearError(); statusText('deletedError', ''); render();
  statusText('deletedStatus', `${action === 'delete' ? 'Deletion' : 'Restore'} saved on device — pending server confirmation.`);
  broadcast(); void sync();
}
$('openDeleted').onclick = () => { statusText('deletedError', ''); statusText('deletedStatus', ''); renderDeleted(); showDialog($('deletedRecords')); };
$('closeDeleted').onclick = () => $('deletedRecords').close();
function titleButton(record, label = `Edit ${record.title}`) {
  const control = button(record.title, () => openEditor(record), label, `${key(record)}:edit`);
  control.className = 'editable-title'; control.title = 'Edit title and details'; return control;
}
function addContextItem(target) {
  if (!target || workspaceReadOnly()) throw new Error('Choose an active list or project before adding an item.');
  const current = scopedRecords()[key(target)];
  if (!current || current.deleted) throw new Error('This destination is no longer available. Choose another list or project.');
  // Reuse the editor without overwriting an unfinished edit or the Capture draft.
  if (editing && JSON.stringify(formValues(edit)) !== JSON.stringify(editing.initialFields)) {
    showDialog($('editor'));
    error('Finish saving this edit before adding another item. Your draft is still here.');
    edit.elements.title.focus();
    return;
  }
  openEditor({ type: 'item', id: crypto.randomUUID(), version: 0, title: '', description: '',
    listId: target.type === 'list' ? target.id : null,
    projectId: target.type === 'project' ? target.id : null,
    status: target.type === 'project' ? 'next' : 'inbox' });
  $('createdDestination').replaceChildren();
}
function openEditor(record, focus = true, show = true) {
  if (focus && editing && JSON.stringify(formValues(edit)) !== JSON.stringify(editing.initialFields) &&
      (editing.id !== record.id || editing.type !== record.type || editing.version !== record.version)) {
    showDialog($('editor'));
    error('Save or discard this unfinished edit before opening another record. Your draft is kept.');
    edit.elements.title.focus();
    renderEditorDraft();
    void journal();
    return;
  }
  if (editing?.id === record.id && editing.type === record.type && editing.version === record.version) {
    if (show) showDialog($('editor'));
    if (focus) { edit.elements.title.focus(); void journal(); }
    renderEditorDraft();
    return;
  }
  editing = { type: record.type, id: record.id, version: record.version, initialFields: record.initialFields };
  edit.reset();
  edit.querySelectorAll('details').forEach(section => { section.open = false; });
  const fields = record.fields ? projected(state)[key(record)] || record.fields : record;
  edit.elements.title.value = fields.title;
  edit.elements.description.value = fields.description || '';
  edit.elements.listId.value = fields.listId || '';
  pickerOptions(editOrganizer, scopedRecords(), memberships(fields));
  $('editOrganizer').hidden = record.type !== 'item';
  $('editCollectionFields').hidden = !isCollection(record);
  edit.elements.kind.value = collectionKind(record);
  for (const option of edit.elements.kind.options) option.disabled = !!record.version && (record.type === 'project' ? option.value !== 'project' : option.value === 'project');
  const parentOptions = Object.values(scopedRecords()).filter(candidate => isCollection(candidate) && !candidate.deleted && !ancestry(candidate, scopedRecords()).some(ref => refKey(ref) === key(record)));
  options(edit.elements.parentRef, parentOptions.map(candidate => ({ id: refKey(candidate), title: collectionLabel(candidate) })), [['', 'No parent']], true);
  edit.elements.parentRef.value = fields.parentRef ? refKey(fields.parentRef) : '';
  options(edit.elements.workspaceId, availableWorkspaces().filter(space => !space.archived), []);
  edit.elements.workspaceId.value = fields.workspaceId || selectedWorkspace;
  $('editWorkspaceLabel').hidden = record.type !== 'item';
  refreshOptions();
  fillValues(edit, { ...fields, projectStatus: record.type === 'project' ? fields.status || 'active' : 'active', parentRef: fields.parentRef ? refKey(fields.parentRef) : '', kind: collectionKind(fields), collectionRefs: memberships(fields), dueLocal: fields.dueLocal ?? localDate(fields.dueDateUtc), status: fields.status || 'inbox' });
  editing.initialFields ??= formValues(edit);
  if (record.fields) fillValues(edit, record.fields);
  $('editListLabel').hidden = record.type !== 'item';
  $('editAdvanced').hidden = record.type !== 'item';
  $('editProjectLifecycle').hidden = record.type !== 'project';
  $('editOutcomeLabel').hidden = record.type !== 'project';
  edit.elements.outcome.required = record.type === 'project';
  $('editHeading').textContent = `${record.version ? 'Edit' : 'New'} ${record.type}`;
  if (record.type === 'item' && record.version === 0) {
    const target = scopedRecords()[fields.projectId ? `project:${fields.projectId}` : `list:${fields.listId}`];
    if (target) $('editHeading').textContent = `Add ${fields.projectId ? 'next action' : 'item'} to ${target.title}`;
  }
  $('original').textContent = projected(state)[key(record)]?.originalText || '';
  $('editError').hidden = true;
  if (show) showDialog($('editor'));
  renderEditorDraft();
  if (focus) { edit.elements.title.focus(); void journal(); }
}

function renderEditorDraft() {
  const retained = hasEditDraft() && !$('editor').open;
  $('savedEdit').hidden = !retained;
  statusText('savedEditStatus', retained ? `Unfinished ${editing.type} edit: ${edit.elements.title.value || 'Untitled'}.` : '');
  $('resumeEdit').disabled = saving || workspaceReadOnly();
  $('discardEdit').disabled = saving;
}
async function discardEdit() {
  const owner = accountId, generation = accountGeneration, pending = editing;
  if (!owner || !pending) return;
  const controls = [...edit.elements];
  saving = true; controls.forEach(control => { control.disabled = true; }); renderEditorDraft();
  try {
    const saved = await transact(owner, local => { currentDraft(local).edit = null; currentDraft(local).editOpen = false; });
    if (owner !== accountId || generation !== accountGeneration || editing !== pending) return;
    state = saved; editing = null; edit.reset(); $('editor').close(); clearError(); render();
  } catch (failure) { if (owner === accountId) storageFailure(failure); }
  finally {
    saving = false; controls.forEach(control => { control.disabled = false; });
    if (accountId) renderEditorDraft();
  }
}

async function updateRecord(record, fields, close = false) {
  const owner = accountId;
  if (!owner) return;
  if (workspaceReadOnly()) throw new Error('Unarchive this workspace before editing.');
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
      if (close && current && record.version > 0) rememberEdit(local, current, fields);
      if (close) currentDraft(local).edit = null;
    });
    if (owner === accountId) state = saved;
  } catch (failure) { if (owner === accountId) storageFailure(failure); return; }
  if (owner !== accountId) return;
  if (!close && record.type === 'item') {
    const current = projected(state)[key(record)];
    recentTaskChange = fields === record.workflowBeforeTransition ? null
      : { owner, workspace: selectedWorkspace, key: key(record), version: current.version };
  }
  if (close) { editing = null; $('editor').close(); }
  clearError(); render();
  if (close && record.version === 0 && ['list', 'project'].includes(record.type)) {
    const target = scopedRecords()[key(record)];
    $('createdDestination').replaceChildren(document.createTextNode(`Created “${target.title}”. `),
      button(target.type === 'project' ? 'Add next action' : 'Add item', () => {
        const mode = target.type === 'project' ? 'work' : 'lists';
        navigation[mode].view = target.type === 'project' ? `project:${target.id}` : target.id;
        history.replaceState(null, '', '#' + mode); workspace(false);
        addContextItem(target);
      }, `Add ${target.type === 'project' ? 'next action to' : 'item to'} ${target.title}`));
  }
  broadcast(); void sync();
}

capture.addEventListener('input', () => { extraction.changed(); void journal(); });
edit.addEventListener('input', () => { void journal(); });
capture.elements.listId.addEventListener('change', refreshOptions);
edit.elements.listId.addEventListener('change', refreshOptions);
capture.addEventListener('submit', event => {
  event.preventDefault();
  if (saving || switchingWorkspace || !accountId || workspaceReadOnly()) return;
  if (extraction.snapshot().draft) { error('A suggested batch is saved for review. Accept it or explicitly discard its suggestions before saving this capture manually.'); return; }
  const focused = document.activeElement;
  saving = true; capture.querySelectorAll('[type=submit]').forEach(control => { control.disabled = true; });
  void (async () => {
    const owner = accountId, submitted = captureDraft();
    try {
      const mutations = captureMutations(submitted);
      const details = taskFields({ ...submitted, projectId: !submitted.newList?.trim() && submitted.listId?.startsWith('project:') ? submitted.listId.slice(8) : null });
      for (const mutation of mutations) {
        if (mutation.type === 'item') Object.assign(mutation.fields, details, { status: 'inbox' });
        else mutation.fields.defaults = structuredClone(userDefaults());
      }
      const saved = await transact(owner, local => {
        enqueue(local, owner, mutations);
        if (JSON.stringify(currentDraft(local).capture) === JSON.stringify(submitted)) { currentDraft(local).capture = {}; currentDraft(local).extraction = { enabled: currentDraft(local).extraction?.enabled === true, includeLists: currentDraft(local).extraction?.includeLists === true }; }
      });
      if (owner !== accountId) return;
      state = saved;
      if (JSON.stringify(captureDraft()) === JSON.stringify(submitted)) {
        capture.reset(); originalInput = undefined; $('previewHelp').hidden = true;
        extraction.reset(true);
      }
      clearError(); statusText('draftStatus', 'Saved on device');
      render();
      if (destination === 'capture' && !document.querySelector('dialog[open]') &&
          (document.activeElement === document.body || document.activeElement === focused)) capture.elements.text.focus();
      broadcast(); void sync();
    } catch (failure) { if (owner === accountId) storageFailure(failure); }
    finally { saving = false; capture.querySelectorAll('[type=submit]').forEach(control => { control.disabled = false; }); }
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
      ...(editing.type === 'item' ? { workspaceId: values.workspaceId, collectionRefs: values.collectionRefs, listId: values.listId || null, ...taskFields(values, editing.initialFields) } : { parentRef: values.parentRef ? parseRef(values.parentRef) : null, ...(editing.type === 'project' ? { outcome: values.outcome, status: values.projectStatus } : { kind: values.kind }) }) };
    if (editing.version === 0 && editing.type === 'list') fields.defaults = structuredClone(userDefaults());
    else if (editing.version > 0 && editing.initialFields) {
      const initial = { ...editing.initialFields, parentRef: editing.initialFields.parentRef ? parseRef(editing.initialFields.parentRef) : null, ...taskFields(editing.initialFields, editing.initialFields), listId: editing.initialFields.listId || null, ...(editing.type === 'project' ? { status: editing.initialFields.projectStatus || 'active' } : {}) };
      fields = Object.fromEntries(Object.entries(fields).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(initial[name])));
      if (!Object.keys(fields).length) { void discardEdit(); return; }
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
$('resumeEdit').onclick = () => { if (editing) openEditor(editing); };
$('discardEdit').onclick = guard(async () => {
  if (saving || !editing || !confirm('Discard this unfinished edit? Saved records and your Capture draft will stay unchanged.')) return;
  await discardEdit();
});
$('undoEdit').onclick = guard(async () => {
  const owner = accountId, generation = accountGeneration, operationId = state?.undoEdit?.operationId;
  if (!owner || !operationId) return;
  const saved = await transact(owner, local => undoEdit(local, owner, operationId));
  if (owner !== accountId || generation !== accountGeneration) return;
  state = saved; clearError(); render(); broadcast(); void sync();
  statusText('undoEditStatus', 'Undo saved on device. Sync to confirm it on the server.');
});
$('editor').addEventListener('close', () => {
  if ($('editor').open) return;
  if (!hasEditDraft()) editing = null;
  if (accountId) { renderEditorDraft(); void journal(); }
});
$('editor').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
function focusDestination() {
  if (!accountId || $('workspace').hidden) return;
  const modal = document.querySelector('dialog[open]');
  if (modal) {
    if (!modal.contains(document.activeElement)) modal.querySelector('input, textarea, select, button')?.focus();
    return;
  }
  (destination === 'capture' ? workspaceReadOnly() ? $('workspaceSelect') : capture.elements.text : destination === 'execute' ? $('executeHeading') : destination === 'reviews' ? $('reviewsHeading') : $('itemsHeading')).focus();
}
function restoreFocus(control) {
  const modal = document.querySelector('dialog[open]'), scope = modal || document;
  if (modal?.contains(document.activeElement) && document.activeElement !== control) return;
  // Labels and DOM nodes can change; record ID plus action remains stable.
  const matching = value => value ? scope.querySelector(`[data-focus-key="${CSS.escape(value)}"]`) : null;
  const target = control?.isConnected && scope.contains(control) ? control
    : matching(control?.dataset.focusKey) || matching(control?.dataset.focusFallback);
  if (target && target !== document.body && !target.disabled && target.getClientRects().length) target.focus();
  else focusDestination();
}
function showDialog(dialog) {
  if (dialog.open) return;
  dialogOpeners.set(dialog, { control: document.activeElement, generation: accountGeneration });
  dialog.showModal();
}
function workspace(focus = true) {
  destination = ['work', 'lists', 'execute', 'reviews'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'capture';
  const listMode = destination === 'lists';
  document.querySelector('.capture-panel').hidden = destination !== 'capture';
  document.querySelector('.work-panel').hidden = !['work', 'lists'].includes(destination);
  $('reviews').hidden = destination !== 'reviews';
  $('execute').hidden = destination !== 'execute';
  $('listTools').hidden = !listMode;
  $('newProject').hidden = listMode;
  document.querySelector('.work-panel').classList.toggle('process-mode', !listMode);
  $('itemsHeading').textContent = listMode ? 'List Workspace' : 'Process';
  $('workEyebrow').hidden = !listMode;
  $('viewLabel').textContent = listMode ? 'List' : 'View';
  $('viewLabel').classList.toggle('sr-only', !listMode);
  $('executionFilters').hidden = !listMode;
  for (const link of document.querySelectorAll('.workspace-nav a')) {
    if (link.hash === '#' + destination) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  render();
  if (focus) { $('createdDestination').replaceChildren(); focusDestination(); void journal(); }
}
$('closeReviews').onclick = () => {
  history.replaceState(null, '', '#capture'); workspace(false); $('openReviews').focus(); void journal();
};
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
for (const dialog of [$('editor'), $('defaultsEditor'), $('preferences'), $('clarifier'), $('briefs'), $('deletedRecords'), $('workspaceManager'), $('extractionReview')]) {
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
$('executeList').onchange = () => {
  navigation.execute.view = $('executeList').value;
  render(); void journal();
};
$('inspectExecute').onclick = () => {
  Object.assign(navigation.lists, { view: navigation.execute.view, status: '@all', context: '', minutes: '', energy: '' });
};
$('executeKinds').onclick = event => {
  const control = event.target.closest('[data-execute-kind]');
  if (!control) return;
  navigation.execute.kind = control.dataset.executeKind;
  navigation.execute.view = '';
  render(); void journal();
};
$('executeFilters').onchange = () => {
  Object.assign(navigation.execute, { context: $('executeContextFilter').value, minutes: $('executeTimeFilter').value, energy: $('executeEnergyFilter').value });
  render(); void journal();
};
$('resetExecuteFilters').onclick = () => {
  Object.assign(navigation.execute, { context: '', minutes: '', energy: '' });
  render(); void journal();
};
$('view').onchange = $('day').onchange = $('statusFilter').onchange = $('statusChoices').onchange = $('executionFilters').onchange = () => {
  $('createdDestination').replaceChildren();
  navigation[destination === 'lists' ? 'lists' : 'work'] = {
    view: $('view').value, status: $('statusFilter').value,
    statuses: [...$('statusChoices').querySelectorAll('input:checked')].map(input => input.value),
    context: $('contextFilter').value, minutes: $('timeFilter').value, energy: $('energyFilter').value
  };
  render(); void journal();
};
$('resetExecutionFilters').onclick = () => {
  Object.assign(navigation[destination === 'lists' ? 'lists' : 'work'], { context: '', minutes: '', energy: '' });
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
        currentDraft(local).defaults = null;
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
  downloadExport(value, readable, readable ? 'todo-tasks.txt' : 'todo-device-recovery.json');
});
function downloadExport(value, readable, filename) {
  const blob = new Blob([readable ? readableExport(value) : JSON.stringify(value, null, 2)], { type: readable ? 'text/plain;charset=utf-8' : 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('accountExport').onclick = async () => {
  if (!accountId || exportController) return;
  const owner = accountId, generation = accountGeneration, controller = new AbortController();
  const readable = $('exportFormat').value === 'text';
  exportController = controller;
  $('accountExport').disabled = true; $('cancelExport').hidden = false;
  statusText('exportStatus', 'Reading server history…');
  try {
    const value = await accountExport(owner, async path => {
      const page = await request(path, undefined, controller.signal);
      if (owner !== accountId || generation !== accountGeneration) controller.abort();
      return page;
    }, { signal: controller.signal, onProgress: (after, through) => statusText('exportStatus', `Reading server history: ${after} of ${through}.`) });
    controller.signal.throwIfAborted();
    if (owner !== accountId || generation !== accountGeneration) return;
    downloadExport(value, readable, readable ? 'todo-account.txt' : 'todo-account.json');
    statusText('exportStatus', 'Server copy downloaded. Pending device saves and drafts are excluded.');
  } catch (failure) {
    if (owner === accountId && generation === accountGeneration) {
      statusText('exportStatus', controller.signal.aborted ? 'Export cancelled. No file was downloaded.' : `Export failed: ${failure.message} You can still export a device copy.`);
      if (!controller.signal.aborted) error($('exportStatus').textContent);
      if ([401, 403].includes(failure.status) || failure.code === 'account_mismatch') {
        await pauseSession('Sign in to the original account to export its server copy. Pending work is kept on this device.');
      }
    }
  } finally {
    if (exportController === controller) {
      const restoreFocus = document.activeElement === $('cancelExport');
      exportController = null; $('accountExport').disabled = false; $('cancelExport').hidden = true;
      if (restoreFocus) $('accountExport').focus();
    }
  }
};
$('cancelExport').onclick = () => exportController?.abort();
$('copyRecovery').onclick = guard(async () => {
  $('recoveryText').select(); await navigator.clipboard.writeText($('recoveryText').value);
});

async function request(path, operation, signal) {
  const response = await fetch(`/api/v1/${path}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), ...(operation ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation) } : {}) });
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
  statusText('accountName', state?.accountName || 'Your account');
  if (!verified) { statusText('sessionStatus', label); return; }
  try {
    const response = await fetch('/.auth/me', { credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    const principal = (await response.json())?.clientPrincipal;
    if (requestId !== profileRequest || generation !== accountGeneration || owner !== accountId) return;
    if (principal?.userId === owner && typeof principal.userDetails === 'string' && principal.userDetails.trim()) {
      const name = principal.userDetails.trim();
      label = `Device inbox for ${name}${offline}`;
      statusText('accountName', name);
      if (state.accountName !== name) {
        const saved = await transact(owner, local => { local.accountName = name; });
        if (requestId === profileRequest && generation === accountGeneration && owner === accountId) state = saved;
      }
    }
  } catch { /* Display metadata must never block capture or synchronization. */ }
  finally {
    if (requestId === profileRequest && generation === accountGeneration && owner === accountId) statusText('sessionStatus', label);
  }
}
function hideAccount() {
  $('appHeader').hidden = true; $('workspaceSkip').hidden = true; $('appUpdateStatus').hidden = true;
  $('appMenu').open = false; $('preferences').close();
  restoreUtility(); utilityForm.elements.entries.replaceChildren(); utilityForm.elements.tag.replaceChildren(); utilityForm.elements.target.replaceChildren(); $('collectionOutline').replaceChildren(); $('collectionBreadcrumbs').textContent = ''; $('collectionChildren').replaceChildren(); edit.elements.parentRef.replaceChildren(); editOrganizer.replaceChildren();
  extraction.reset();
  $('deletedRecords').close(); $('deletedItems').replaceChildren(); $('deletedError').textContent = ''; $('deletedStatus').textContent = '';
  exportController?.abort();
  $('exportStatus').textContent = '';
  reviews.reset();
  briefs.reset();
  if (accountId) history.replaceState(null, '', location.pathname + location.search + '#capture');
  navigation = emptyNavigation();
  $('view').replaceChildren(new Option('All items', 'all'));
  $('executeList').replaceChildren(new Option('Choose a list', '')); $('executeItems').replaceChildren();
  $('executeContextFilter').replaceChildren(new Option('Any context', ''));
  $('executeTimeFilter').value = $('executeEnergyFilter').value = '';
  $('executeFilters').open = false; $('executeFilterSummary').textContent = 'Context, time & energy';
  $('statusFilter').replaceChildren(new Option('Incomplete items', ''));
  $('statusSelection').hidden = true; $('statusChoices').replaceChildren();
  $('contextFilter').replaceChildren(new Option('Any context', ''));
  $('timeFilter').value = $('energyFilter').value = '';
  $('executionFilters').open = false; $('executionSummary').textContent = 'Context, time & energy';
  $('failure').hidden = true; $('comparison').textContent = ''; $('failureMessage').textContent = '';
  $('syncStatus').textContent = ''; clearError();
  $('connectionLabel').textContent = ''; $('saveStatus').hidden = true;
  delete $('saveStatus').dataset.state; $('saveStatus').removeAttribute('title');
  $('accountName').textContent = 'Welcome'; $('workspaceSelect').hidden = true;
  $('signedOut').hidden = false; $('loginStatus').textContent = 'Sign in to continue.';
  document.title = 'Sign in';
  $('menuDeviceTools').hidden = true;
  $('undoEdit').disabled = true; $('undoEditStatus').textContent = '';
  recentTaskChange = null; $('recentTaskChange').hidden = true; $('recentTaskChangeStatus').textContent = '';
  accountGeneration++;
  profileRequest++;
  $('sessionStatus').textContent = 'Your device inbox';
  selectedWorkspace = PERSONAL; $('workspaceSelect').replaceChildren(); $('workspaceManager').close(); $('workspaceEntries').replaceChildren();
  $('createWorkspace').reset(); $('workspaceError').textContent = $('workspaceStatus').textContent = '';
  accountId = null; state = undefined; editing = null; originalInput = undefined;
  $('savedEdit').hidden = true; $('savedEditStatus').textContent = '';
  clarification.hide();
  defaultsEditing = null; $('defaultsEditor').close(); $('defaultsForm').reset();
  $('editor').close(); $('editError').hidden = true; $('original').textContent = '';
  capture.reset(); edit.reset(); $('items').replaceChildren(); $('lists').replaceChildren();
  $('projectOutcome').textContent = ''; $('projectActions').replaceChildren(); $('day').value = '';
  $('createdDestination').replaceChildren(); $('addContextItem').hidden = true;
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
      await pauseSession('Sign in to continue.');
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
    accountId = identity.accountId; state = saved; selectedWorkspace = saved.selectedWorkspace || PERSONAL;
    render(); $('workspace').hidden = false; restoreDraft(); broadcast();
  }
  $('workspace').hidden = false; $('signOut').hidden = false; $('signIn').hidden = true;
  $('menuDeviceTools').hidden = false;
  $('signedOut').hidden = true; $('workspaceSelect').hidden = false; $('saveStatus').hidden = false;
  $('appHeader').hidden = false; $('workspaceSkip').hidden = false; $('appUpdateStatus').hidden = false;
  void showAccountName(accountId, generation, verified);
  return accountId;
}

async function sync() {
  if (syncing || !navigator.onLine || document.hidden) return;
  syncing = true; clearTimeout(retryTimer);
  connectionStatus();
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
      if (accountId) await pauseSession('Session changed or expired. Sign in to the original account to resume its pending work.');
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
    connectionStatus();
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
    const discarded = local.queue.shift();
    if (local.undoEdit && discarded.operation.mutations.some(mutation => key(mutation) === key(local.undoEdit))) delete local.undoEdit;
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
    hideAccount(); $('sessionStatus').textContent = $('loginStatus').textContent = 'Account changed in another tab. Sign in or reload to continue.';
  } else if (accountId) {
    const owner = accountId, savedState = await transact(owner);
    if (owner === accountId) { state = savedState; render(); }
  }
});
addEventListener('online', () => { void sync(); });
addEventListener('offline', () => { profileRequest++; $('sessionStatus').textContent = 'Offline — saves remain on this device until you reconnect.'; render(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
  if (!document.hidden && navigator.onLine) { $('workspace').hidden = true; void sync(); }
});
addEventListener('focus', () => { render(); if (navigator.onLine) void sync(); });

try {
  await session({ allowOffline: true });
} catch (failure) { if (![401, 403].includes(failure.status)) error(failure.message); }
syncing = false;
connectionStatus();
if (accountId) void sync();
