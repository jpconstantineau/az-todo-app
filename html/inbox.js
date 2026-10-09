import { activeMemberships, archiveOnly, archivedAncestor, collectionKinds, collectionKind, isCollection, isEffectivelyArchived, memberships, belongsTo, inCollection, ancestry, refKey, collectionContents, normalizeMembership } from './collection-model.js?v=5';
import { organizer, pickerOptions, selectedRefs, membershipFields, collectionLabel, viewKey, parseRef, drawOutline } from './collections.js?v=5';
import { PERSONAL, workspaceOf, workspaceRecords, workspaceDraft } from './workspaces.js?v=5';
import { collectionMoveMutations, collectionMovePlan } from './workspace-move.js?v=5';
import { transact, clearDeviceDatabase, key, projected, enqueue as queueMutations, enqueueCapture, applyReceipt, captureMutations, rememberEdit, canUndoEdit, undoEdit, beginCollectionMove, continueCollectionMove, resumeCollectionMove } from './inbox-store.js?v=15';
import { optionFields, formValues, fillValues, localDate, taskFields, addTaskControls, refreshTaskOptions, defaultsFrom, validateWorkflow, reviewReady, matchesExecutionFilters, readyToExecute } from './inbox-fields.js?v=4';
import { deviceExport, accountExport, readableExport } from './inbox-export.js?v=18';
import { collectionPaths, defaultSearch, searchWorkspace } from './search-model.js?v=1';
import { clarificationUI } from './clarification.js?v=11';
import { currentClarificationActions, setupClarificationPreferences } from './clarification-preferences.js?v=3';
import { mergeReflectionConflict, setupReviews } from './reviews.js?v=11';
import { setupBriefs } from './briefs.js?v=6';
import { setupProjectPlanning } from './project-planning.js?v=1';
import { recoverProjectPlanDraft } from './project-planning-model.js?v=1';
import { setupCaptureExtraction, extractionMutations } from './capture-extraction.js?v=2';
import { setupAgentStatus } from './local-agent.js?v=1';
import { localMonday, membershipPlanMutations, setupPlan } from './plan.js?v=5';
import { resolveOccurrenceMutations } from './recurrence-model.js?v=1';
import { setupRecurrence } from './recurrence-ui.js?v=3';

const $ = id => document.getElementById(id);
setupAgentStatus();
const clarificationPreferences = setupClarificationPreferences();
const capture = $('capture'), edit = $('edit');
let accountId = null, state, editing = null, originalInput;
let saving = false, syncing = true, retryTimer, retryDelay = 2000, accountGeneration = 0;
let defaultsEditing = null, recentTaskChange = null;
let exportController;
let splitFeedbackTimer;
let materializingRecurrence = false;
let savedViewEditing = null;
let selectedWorkspace = PERSONAL, switchingWorkspace = false;
const workflowRoutes = ['capture', 'work', 'lists', 'plan', 'execute', 'reviews'];
const preferenceCategories = [
  { id: 'appearance', label: 'Appearance', scope: 'Browser', section: 'preferencesAppearance' },
  { id: 'capture', label: 'Capture' },
  { id: 'process', label: 'Process', scope: 'Browser', section: 'preferencesProcess' },
  { id: 'organize', label: 'Organize' },
  { id: 'plan', label: 'Plan' },
  { id: 'do', label: 'Do' },
  { id: 'review', label: 'Review' },
  { id: 'task-options', label: 'Task options', scope: 'Account', section: 'preferencesTaskOptions' }
];
const livePreferenceCategories = preferenceCategories.filter(category => category.section);
const preferenceRoutes = new Map(livePreferenceCategories.map(category => [`preferences/${category.id}`, category]));
const clarifyPreferenceRoot = 'preferences/process/clarify-actions';
function clarifyPreferenceRoute(route) {
  if (typeof route !== 'string') return null;
  if (route === clarifyPreferenceRoot) return { view: 'list' };
  if (route === `${clarifyPreferenceRoot}/add`) return { view: 'editor', id: null };
  const match = route.match(/^preferences\/process\/clarify-actions\/edit\/([A-Za-z0-9_-]{1,128})$/);
  return match ? { view: 'editor', id: match[1] } : null;
}
const preferenceCategory = route => preferenceRoutes.get(route) || (clarifyPreferenceRoute(route) ? preferenceRoutes.get('preferences/process') : null);
const isPreferenceRoute = route => route === 'preferences' || !!preferenceCategory(route);
function preferenceRouteTitle(route) {
  const clarify = clarifyPreferenceRoute(route);
  if (clarify?.view === 'list') return 'Clarify actions';
  if (clarify?.view === 'editor') return clarify.id ? 'Edit Clarify action' : 'Add Clarify action';
  return preferenceRoutes.get(route)?.label;
}
function preferenceRouteParent(route) {
  const clarify = clarifyPreferenceRoute(route);
  if (clarify?.view === 'list') return { parent: 'preferences/process', target: 'openClarifyActions' };
  if (clarify?.view === 'editor') return { parent: clarifyPreferenceRoot, target: clarify.id ? `clarify-action-${clarify.id}` : 'addClarifyAction' };
  const category = preferenceRoutes.get(route);
  return category ? { parent: 'preferences', target: `preference-${category.id}` } : null;
}
const menuHistorySession = crypto.randomUUID();
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const scopedRecords = () => workspaceRecords(projected(state), selectedWorkspace);
const currentDraft = local => workspaceDraft(local, selectedWorkspace);
function normalizeCaptureDraft(value = {}) {
  const { body, ...captureDraft } = value || {};
  if (typeof body === 'string' && body.trim()) captureDraft.text = captureDraft.text ? `${captureDraft.text}\n${body}` : body;
  return Object.fromEntries(['text', 'contexts', 'listId', 'newList', 'original']
    .filter(name => Object.hasOwn(captureDraft, name)).map(name => [name, captureDraft[name]]));
}
function normalizeExtractionDraft(value) {
  const extractionDraft = value ? structuredClone(value) : value;
  if (extractionDraft?.draft?.inputCapture) extractionDraft.draft.inputCapture = normalizeCaptureDraft(extractionDraft.draft.inputCapture);
  return extractionDraft;
}
function availableWorkspaces() {
  return [{ id: PERSONAL, type: 'workspace', title: 'Personal', version: 0 }, ...Object.values(projected(state)).filter(record => record.type === 'workspace' && !record.deleted)];
}
function renderWorkspaces() {
  const spaces = availableWorkspaces();
  options($('workspaceSelect'), spaces.map(space => ({ ...space, title: space.title + (space.archived ? ' (archived)' : '') })), []);
  if (!spaces.some(space => space.id === selectedWorkspace)) $('workspaceSelect').add(new Option('Unavailable workspace', selectedWorkspace));
  $('workspaceSelect').value = selectedWorkspace;
  const workspaceTitle = $('workspaceSelect').selectedOptions[0].textContent;
  const preferenceTitle = preferenceRouteTitle(destination);
  document.title = (preferenceTitle || (destination === 'preferences' ? 'Preferences' : destination === 'capture' ? 'Capture' : destination === 'lists' ? 'Organize' : destination === 'plan' ? 'Plan' : destination === 'execute' ? 'Execute' : destination === 'reviews' ? 'Review' : destination === 'menu' ? 'Menu' : 'Process')) + ' · ' + workspaceTitle;
  statusText('menuWorkspaceValue', workspaceTitle);
  statusText('workspaceStatus', workspaceReadOnly() ? 'This workspace is read-only or deleted. Open Menu → Workspaces to unarchive or restore it. Drafts are kept.' : '');
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
    $('editor').close(); $('defaultsEditor').close(); $('savedViewEditor').close(); $('deletedRecords').close();
    extraction.reset(); clarification.hide(); reviews.reset(); briefs.reset(); projectPlanning.reset();
    state = saved; selectedWorkspace = id;
    render(); restoreDraft();
    if (!document.querySelector('dialog[open]')) $('workspaceSelect').focus();
  } catch (failure) { $('workspaceSelect').value = selectedWorkspace; storageFailure(failure); }
  finally { switchingWorkspace = false; }
}
$('workspaceSelect').onchange = guard(() => switchWorkspace($('workspaceSelect').value));
$('manageWorkspaces').onclick = () => { renderWorkspaces(); showDialog($('workspaceManager')); };
$('closeWorkspaces').onclick = () => $('workspaceManager').close();
$('openDataRecovery').onclick = () => { showDialog($('dataRecovery')); $('dataRecoveryHeading').focus(); };
$('closeDataRecovery').onclick = () => $('dataRecovery').close();
$('openAppDevice').onclick = () => { showDialog($('appDevice')); $('appDeviceHeading').focus(); };
$('closeAppDevice').onclick = () => $('appDevice').close();
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
  if (editing?.type === 'item') {
    const records = scopedRecords();
    options(edit.elements.listId, moving ? [] : Object.values(records).filter(record => record.type === 'list' && !record.deleted && !isEffectivelyArchived(record, records)), [['', 'No list']]);
    options(edit.elements.projectId, moving ? [] : Object.values(records).filter(record => record.type === 'project' && !record.deleted && !isEffectivelyArchived(record, records)), [['', 'No project']]);
    if (moving) { edit.elements.listId.value = edit.elements.projectId.value = ''; pickerOptions(edit.elements.collectionRefs, {}, []); } else pickerOptions(edit.elements.collectionRefs, scopedRecords(), selectedRefs(edit.elements.collectionRefs));
  } else {
    if (moving) edit.elements.parentRef.value = '';
    edit.elements.parentRef.disabled = moving;
  }
  void journal();
};
function enqueue(local, owner, mutations) {
  queueMutations(local, owner, mutations);
}
function ensurePlanMutationsAvailable(local, mutations) {
  const touched = new Set(mutations.map(key));
  if (local.queue.some(entry => entry.failure && entry.operation.mutations.some(mutation => touched.has(key(mutation))))) {
    throw new Error('Resolve this plan conflict before changing the same day. Other dates remain available.');
  }
}
function workspaceReadOnly(workspaceId = selectedWorkspace) {
  const space = projected(state)['workspace:' + workspaceId];
  return workspaceId !== PERSONAL && (!space || space.deleted || space.archived);
}
const dialogOpeners = new Map();
const recurrence = setupRecurrence({ records: () => accountId ? projected(state) : {}, workspaceId: () => selectedWorkspace,
  readOnly: workspaceReadOnly, showDialog, restoreFocus, journal, label: collectionLabel, save: saveRecurrence });
async function saveRecurrence(mutations, message, clearRecurrenceDraft = false, targetWorkspaceId = selectedWorkspace) {
  const owner = accountId, generation = accountGeneration;
  if (!owner || workspaceReadOnly(targetWorkspaceId)) throw new Error('Choose an active workspace before changing recurring work.');
  const saved = await transact(owner, local => {
    if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before changing recurring work.');
    const records = projected(local);
    for (const mutation of mutations) {
      const current = records[key(mutation)];
      if (mutation.action === 'create' ? current : !current || current.deleted || current.version !== mutation.expectedVersion) throw new Error('This recurring series changed. Reopen it and compare the latest state.');
    }
    enqueue(local, owner, mutations);
    if (clearRecurrenceDraft) currentDraft(local).recurrence = null;
  });
  if (owner !== accountId || generation !== accountGeneration) throw new Error('Account changed; the recurring save remains with its original account.');
  state = saved; statusText('recurringStatus', message); clearError(); render(); broadcast(); void sync();
  setTimeout(() => void materializeRecurrence(), 0);
}
async function materializeRecurrence() {
  if (materializingRecurrence || !accountId || document.hidden) return;
  materializingRecurrence = true;
  try { while (await recurrence.materialize()) { /* One bounded operation at a time; each template creates at most one open item. */ } }
  catch (failure) { if (accountId) error(`Recurring work was not created: ${failure.message}`); }
  finally { materializingRecurrence = false; }
}
const extraction = setupCaptureExtraction({ journal, showDialog, recovery: storageFailure,
  current: () => {
    if (!accountId || workspaceReadOnly()) return null;
    const records = scopedRecords();
    return { ...captureDraft(), accountId, lists: Object.values(records).filter(record => isCollection(record) && !record.deleted && !isEffectivelyArchived(record, records)).map(record => ({ id: record.type === 'project' ? refKey(record) : record.id, title: collectionLabel(record) })) };
  },
  save: async submitted => {
    const owner = accountId, generation = accountGeneration;
    if (!owner || workspaceReadOnly()) throw new Error('Choose an active workspace to accept these suggestions.');
    if (JSON.stringify(captureDraft()) !== JSON.stringify(submitted.inputCapture)) throw new Error('Capture changed. Your reviewed suggestions are kept; return to capture before starting a new review.');
    const saved = await transact(owner, local => {
      if (JSON.stringify(normalizeExtractionDraft(currentDraft(local).extraction)?.draft) !== JSON.stringify(submitted) || JSON.stringify(normalizeCaptureDraft(currentDraft(local).capture)) !== JSON.stringify(submitted.inputCapture)) throw new Error('This capture changed in another tab. Reload to inspect the saved draft.');
      const records = projected(local);
      // Stable task IDs survive reviewed edits. A stale tab cannot accept twice,
      // even after the operation is acknowledged or an accepted task is deleted.
      if (Object.values(records).some(record => record.captureId === submitted.id)) throw new Error('This capture was already accepted. Reload to see its tasks.');
      if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before accepting this batch.');
      enqueue(local, owner, extractionMutations(submitted, workspaceRecords(records, selectedWorkspace), selectedWorkspace));
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
  if (menu?.open && menu.id === 'connection') {
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
const projectPlanning = setupProjectPlanning({ records: () => accountId ? scopedRecords() : {}, journal, showDialog, save: async (mutations, draft) => {
  const owner = accountId, generation = accountGeneration;
  if (!owner) throw new Error('Sign in to accept this project plan.');
  const saved = await transact(owner, local => {
    if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before accepting this plan. Your draft is kept.');
    const records = projected(local), projectMutation = mutations.find(mutation => mutation.type === 'project');
    const project = records[`project:${projectMutation.id}`];
    if (!project || project.deleted || project.version !== projectMutation.expectedVersion || project.localState) throw new Error('This project changed. Recover the draft against the latest project before accepting.');
    const stored = currentDraft(local).projectPlanning;
    if (!stored || stored.projectId !== draft.projectId || JSON.stringify(stored.sections) !== JSON.stringify(draft.sections) || JSON.stringify(stored.candidates) !== JSON.stringify(draft.candidates)) throw new Error('The saved planning draft changed in another tab. Reload and review it before accepting.');
    enqueue(local, owner, mutations);
    currentDraft(local).projectPlanning = null;
  }).catch(failure => { if (owner === accountId) storageFailure(failure); throw failure; });
  if (owner !== accountId || generation !== accountGeneration) throw new Error('Account changed; the plan remains with its original account.');
  state = saved; clearError(); render(); broadcast(); void sync();
} });
const clarification = clarificationUI({ records: () => scopedRecords(), journal, save: saveClarification, showDialog, actions: currentClarificationActions });
async function saveClarification(mutations, next) {
  const owner = accountId;
  if (!owner) return false;
  const saved = await transact(owner, local => {
    const records = projected(local);
    const planning = mutations.flatMap(mutation => {
      const current = records[key(mutation)];
      return mutation.type === 'item' && mutation.action === 'update' && current && Object.hasOwn(mutation.fields || {}, 'plannedDay')
        ? membershipPlanMutations(records, current.workspaceId, current, mutation.fields.plannedDay) : [];
    });
    const complete = [...mutations, ...planning];
    ensurePlanMutationsAvailable(local, complete);
    for (const mutation of complete) {
      const current = records[key(mutation)];
      const expectedDeleted = mutation.action === 'restore';
      if (!!current?.deleted !== expectedDeleted && mutation.action !== 'create' || (current?.version || 0) !== mutation.expectedVersion) throw new Error('This item or clarification changed. Your draft is kept. Stop, export a copy, and reopen the latest clarification to compare.');
    }
    enqueue(local, owner, complete);
    currentDraft(local).clarification = next;
  }).catch(failure => { if (owner === accountId) storageFailure(failure); throw failure; });
  if (owner !== accountId) return false;
  state = saved; render(); broadcast(); void sync(); return true;
}
let destination = 'capture';
const emptyNavigation = () => ({ work: { view: 'inbox', status: '', search: defaultSearch() }, lists: { view: '', status: '' }, plan: { focus: '', week: localMonday() }, execute: { kind: 'list', view: '' } });
let navigation = emptyNavigation();
const reviews = setupReviews({ current: () => accountId ? state : null, records: scopedRecords, workspaceId: () => selectedWorkspace, journal,
  openPlan: day => {
    if (day) { $('day').value = day; $('planDay').value = day; }
    location.hash = 'plan';
  },
  edit: record => {
    if (editing && (key(editing) !== key(record) || editing.version !== record.version) && JSON.stringify(formValues(edit)) !== JSON.stringify(editing.initialFields)) {
      showDialog($('editor')); error('Finish saving this edit before editing another record. Your draft is still here.');
      edit.elements.title.focus(); return;
    }
    openEditor(record);
  },
  clarify: record => clarification.open(record), addAction: addContextItem, save: async (mutations, nextDraft) => {
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
    if (nextDraft) currentDraft(local).review = nextDraft.review;
  }).catch(failure => { if (owner === accountId) storageFailure(failure); throw failure; });
  if (owner !== accountId || generation !== accountGeneration) throw new Error('Account changed; the save remains with its original account.');
  state = saved; clearError(); render(); broadcast(); void sync();
} });
async function saveDailyPlan(mutations) {
  const owner = accountId, generation = accountGeneration;
  if (!owner) return false;
  if (workspaceReadOnly()) throw new Error('Unarchive this workspace before editing its plan.');
  try {
    const saved = await transact(owner, local => {
      const current = projected(local);
      ensurePlanMutationsAvailable(local, mutations);
      for (const mutation of mutations) {
        const record = current[key(mutation)], version = record?.version || 0;
        if (version !== mutation.expectedVersion || record?.deleted) throw new Error('This plan changed. Review the latest day and try again.');
      }
      enqueue(local, owner, mutations);
    });
    if (owner !== accountId || generation !== accountGeneration) return false;
    state = saved; clearError(); render(); broadcast(); void sync(); return true;
  } catch (failure) { if (owner === accountId) storageFailure(failure); return false; }
}
const planner = setupPlan({ records: scopedRecords, workspaceId: () => selectedWorkspace, navigation: () => navigation.plan, readOnly: workspaceReadOnly,
  save: async (record, fields) => { if (!await updateRecord(record, fields)) render(); },
  savePlan: saveDailyPlan,
  edit: record => openEditor(record),
  inspectDeleted: record => {
    renderDeleted(); showDialog($('deletedRecords'));
    $('deletedRecords').querySelector(`[data-focus-key="${CSS.escape(`${key(record)}:restore`)}"]`)?.focus();
  },
  openCollection: record => {
    navigation.lists.view = record ? viewKey(record) : '';
    location.hash = 'lists';
  },
  openProcess: (action, day) => {
    if (action === 'set-day' || action === 'open-day') $('day').value = day;
    if (action === 'inbox') navigation.work.view = 'inbox';
    if (action === 'open-day') navigation.work.view = 'day';
    if (action !== 'set-day') location.hash = 'work';
  }, journal });
addTaskControls($('editFields'));
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
edit.elements.projectStatus.addEventListener('change', () => { edit.elements.outcome.required = edit.elements.projectStatus.value !== 'draft'; void journal(); });
$('includeNested').onchange = () => { navigation.lists.nested = $('includeNested').checked; render(); void journal(); };

for (const [name, title] of Object.entries(optionFields)) {
  const label = document.createElement('label'); label.textContent = title;
  const input = document.createElement('textarea'); input.name = name; input.rows = 3;
  label.append(input); $('defaultsFields').append(label);
}
function userDefaults() { return { ...state.defaultSettings, ...(projected(state)['settings:settings']?.defaults ?? {}) }; }
function effectiveDefaults(listId) { return { ...userDefaults(), ...projected(state)[`list:${listId}`]?.defaults }; }
function refreshOptions() {
  refreshTaskOptions(capture, effectiveDefaults(capture.elements.listId.value));
  refreshTaskOptions(edit, effectiveDefaults(edit.elements.listId.value));
}
const collectionSettingsForm = $('collectionSettingsForm');
collectionSettingsForm.elements.kind.replaceChildren(...Object.entries(collectionKinds).map(([kind, label]) => new Option(label, kind)));
function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function renderCollectionSettings(context, records, listMode) {
  const recordMap = scopedRecords();
  const due = records.filter(record => isCollection(record) && !isEffectivelyArchived(record, recordMap) && record.revisitDate && record.revisitDate <= localDay())
    .sort((a, b) => a.revisitDate.localeCompare(b.revisitDate) || a.title.localeCompare(b.title));
  $('readyToRevisit').hidden = !listMode || !due.length;
  $('readyToRevisitCollections').replaceChildren(...due.map(record => button(
    `${record.title} · ${record.revisitDate}`,
    () => { navigation.lists.view = viewKey(record); render(); void journal(); },
    `Open ${record.title}, ready to revisit since ${record.revisitDate}`,
    `revisit:${key(record)}`
  )));
  $('collectionSettings').hidden = !listMode || !context;
  if (!listMode || !context) {
    collectionSettingsForm.dataset.key = '';
    statusText('collectionSettingsStatus', '');
    return;
  }
  if (collectionSettingsForm.dataset.key !== key(context)) statusText('collectionSettingsStatus', '');
  collectionSettingsForm.dataset.key = key(context);
  collectionSettingsForm.elements.kind.value = collectionKind(context);
  for (const option of collectionSettingsForm.elements.kind.options) {
    option.disabled = context.type === 'project' ? option.value !== 'project' : option.value === 'project';
  }
  collectionSettingsForm.elements.kind.disabled = context.type === 'project' || workspaceReadOnly();
  const parents = records.filter(candidate => isCollection(candidate) && !isEffectivelyArchived(candidate, recordMap) && key(candidate) !== key(context) &&
    !ancestry(candidate, recordMap).some(ref => refKey(ref) === key(context)));
  options(collectionSettingsForm.elements.parentRef,
    parents.map(candidate => ({ id: refKey(candidate), title: collectionLabel(candidate) })), [['', 'No parent']]);
  collectionSettingsForm.elements.parentRef.value = context.parentRef ? refKey(context.parentRef) : '';
  collectionSettingsForm.elements.revisitDate.value = context.revisitDate || '';
  $('collectionSettingsHelp').textContent = context.type === 'project'
    ? 'Projects stay projects. Parent and revisit changes keep the project outcome, actions and history.'
    : `${collectionKind(context) === 'reference' ? 'Reusable reference is for non-actionable source material. A revisit date only resurfaces the collection; it does not turn entries into actions. ' : ''}Changing type, parent or revisit date keeps contents and history.`;
  for (const control of collectionSettingsForm.elements) control.disabled = workspaceReadOnly() || control.name === 'kind' && context.type === 'project';
  $('archiveCollection').disabled = workspaceReadOnly();
}
collectionSettingsForm.onsubmit = event => {
  event.preventDefault();
  if (saving || !accountId || workspaceReadOnly()) return;
  const record = scopedRecords()[collectionSettingsForm.dataset.key];
  if (!record) { statusText('collectionSettingsStatus', 'This collection is no longer available. Choose it again.'); return; }
  const submitted = {
    ...(record.type === 'list' ? { kind: collectionSettingsForm.elements.kind.value } : {}),
    parentRef: collectionSettingsForm.elements.parentRef.value ? parseRef(collectionSettingsForm.elements.parentRef.value) : null,
    revisitDate: collectionSettingsForm.elements.revisitDate.value || null
  };
  const fields = Object.fromEntries(Object.entries(submitted).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(record[name] ?? null)));
  if (!Object.keys(fields).length) { statusText('collectionSettingsStatus', 'No collection setting changes to save.'); return; }
  saving = true;
  const controls = [...collectionSettingsForm.elements]; controls.forEach(control => { control.disabled = true; });
  void updateRecord(record, fields).then(saved => {
    if (!saved || accountId === null) return;
    statusText('collectionSettingsStatus', 'Collection settings saved on device.');
    collectionSettingsForm.querySelector('[type=submit]')?.focus();
  }).finally(() => {
    saving = false;
    if (accountId) render();
  });
};
let archiveReviewing = null;
const collectionPath = (record, records) => ancestry(record, records).reverse().map(ref => records[refKey(ref)]?.title || `Unavailable ${ref.type}`).join(' / ');
function archiveImpact(record, records) {
  const proposed = { ...records, [key(record)]: { ...record, archived: true } };
  const descendants = Object.values(records).filter(candidate => isCollection(candidate) && !candidate.deleted && key(candidate) !== key(record) &&
    ancestry(candidate, records).some(ref => refKey(ref) === key(record))).length;
  const linked = Object.values(records).filter(candidate => ['item', 'recurrenceTemplate'].includes(candidate.type) && !candidate.deleted &&
    memberships(candidate).some(ref => ancestry(ref, records).some(parent => refKey(parent) === key(record))));
  const unfinished = linked.filter(candidate => candidate.type === 'item' && !['completed', 'dropped', 'reference'].includes(candidate.status));
  return {
    descendants,
    archiveOnlyActions: unfinished.filter(candidate => !archiveOnly(candidate, records) && archiveOnly(candidate, proposed)).length,
    stillActiveActions: unfinished.filter(candidate => !archiveOnly(candidate, proposed)).length,
    templates: linked.filter(candidate => candidate.type === 'recurrenceTemplate' && !candidate.tombstoned && !archiveOnly(candidate, records) && archiveOnly(candidate, proposed)).length
  };
}
function openArchiveReview(record) {
  const records = scopedRecords(), impact = archiveImpact(record, records);
  archiveReviewing = record;
  $('archiveReviewSummary').textContent = `Archive “${record.title}” and set aside its archived-only work?`;
  $('archiveReviewCounts').replaceChildren(...[
    `${impact.descendants} descendant collection${impact.descendants === 1 ? '' : 's'} will be hidden with it`,
    `${impact.archiveOnlyActions} unfinished action${impact.archiveOnlyActions === 1 ? '' : 's'} will become archive-only`,
    `${impact.stillActiveActions} linked action${impact.stillActiveActions === 1 ? '' : 's'} will remain active through another membership`,
    `${impact.templates} recurring template${impact.templates === 1 ? '' : 's'} will pause materialization while archive-only`
  ].map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
  showDialog($('archiveReview')); $('archiveReviewHeading').focus();
}
$('archiveCollection').onclick = () => {
  const record = scopedRecords()[collectionSettingsForm.dataset.key];
  if (record) openArchiveReview(record);
};
$('cancelArchive').onclick = () => $('archiveReview').close();
$('confirmArchive').onclick = guard(async () => {
  const record = archiveReviewing && scopedRecords()[key(archiveReviewing)];
  if (!record || record.archived || isEffectivelyArchived(record, scopedRecords())) throw new Error('This collection changed. Close the review and inspect its latest state.');
  const saved = await updateRecord(record, { archived: true });
  if (!saved) return;
  archiveReviewing = null; $('archiveReview').close(); navigation.lists.view = '@archived'; render(); void journal();
  statusText('archiveStatus', 'Collection archived — saved on device, pending server confirmation.');
  $('archiveHeading').focus();
});
$('archiveReview').addEventListener('close', () => { archiveReviewing = null; });
$('archiveSearch').addEventListener('input', () => renderArchive(true, scopedRecords()));
function renderArchive(open, records) {
  $('archiveBrowser').hidden = !open;
  if (!open) return;
  const query = $('archiveSearch').value.trim().toLocaleLowerCase();
  const archivedMemberships = record => memberships(record).map(ref => ({ ref, ancestor: archivedAncestor(ref, records) })).filter(entry => entry.ancestor);
  const candidates = Object.values(records).filter(record => !record.deleted && (
    isCollection(record) ? isEffectivelyArchived(record, records) : ['item', 'recurrenceTemplate'].includes(record.type) && archivedMemberships(record).length));
  const results = candidates.filter(record => {
    const paths = isCollection(record) ? [collectionPath(record, records)] : archivedMemberships(record).map(entry => collectionPath(records[refKey(entry.ref)] || entry.ancestor, records));
    return !query || [record.title, record.description, record.outcome, record.originalText, record.status, ...paths].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  }).sort((a, b) => Number(isCollection(b)) - Number(isCollection(a)) || (a.title || '').localeCompare(b.title || ''));
  $('archiveResults').replaceChildren(...results.map(record => {
    const article = document.createElement('article'), heading = document.createElement('h4'), reason = document.createElement('p'), notes = document.createElement('p'), actions = document.createElement('div');
    article.className = 'archive-result'; heading.textContent = record.title || record.id; actions.className = 'actions';
    if (isCollection(record)) {
      const ancestor = archivedAncestor(record, records);
      reason.textContent = `${collectionKinds[collectionKind(record)]} · Archived with ${collectionPath(ancestor || record, records)}`;
      notes.textContent = record.outcome || record.description || 'Contents and history retained.';
      const retained = Object.values(records).filter(candidate => !candidate.deleted && (
        isCollection(candidate) ? candidate.parentRef && refKey(candidate.parentRef) === key(record) :
          ['item', 'recurrenceTemplate'].includes(candidate.type) && belongsTo(candidate, record)));
      const contents = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul');
      summary.textContent = `Inspect retained contents of ${record.title}`;
      list.append(...retained.map(candidate => {
        const item = document.createElement('li');
        item.textContent = `${isCollection(candidate) ? collectionKinds[collectionKind(candidate)] : candidate.type === 'recurrenceTemplate' ? 'Recurring template' : `Item (${candidate.status || 'unknown status'})`}: ${candidate.title}`;
        return item;
      }));
      if (!retained.length) list.append(Object.assign(document.createElement('li'), { textContent: 'No directly retained contents.' }));
      contents.append(summary, list); actions.append(contents);
      if (record.archived) {
        const reactivate = button(`Reactivate ${record.title}`, async () => {
          await updateRecord(record, { archived: false });
          statusText('archiveStatus', 'Collection reactivated — saved on device, pending server confirmation.');
          $('view').focus();
        }, `Reactivate ${record.title}`, `archive:${key(record)}:reactivate`);
        reactivate.disabled = workspaceReadOnly(); actions.append(reactivate);
      } else reason.append(` · Reactivate ${ancestor.title} to restore this route.`);
    } else {
      const archived = archivedMemberships(record), active = activeMemberships(record, records);
      reason.textContent = archiveOnly(record, records)
        ? `Archived with ${collectionPath(archived[0].ancestor, records)}`
        : `Still active in ${active.map(ref => collectionPath(records[refKey(ref)], records)).join(', ')} · Also archived with ${collectionPath(archived[0].ancestor, records)}`;
      notes.textContent = `${record.type === 'recurrenceTemplate' ? 'Recurring template' : record.status || 'Item'} · ${record.description || record.originalText || 'History retained.'}`;
      const inspect = button(record.type === 'item' ? 'Open item' : 'Open template and history', () => record.type === 'item' ? openEditor(record) : recurrence.open(record), `Open ${record.title}`, `archive:${key(record)}:open`);
      inspect.disabled = workspaceReadOnly() && record.type === 'item'; actions.append(inspect);
    }
    article.append(heading, reason, notes, actions); return article;
  }));
  statusText('archiveStatus', `${results.length} archived result${results.length === 1 ? '' : 's'}${query ? ` for “${$('archiveSearch').value.trim()}”` : ''}.`);
  if (!results.length) $('archiveResults').textContent = query ? 'No archived history matches this search.' : 'No collections are archived in this workspace.';
}
const channel = new BroadcastChannel('todo-inbox');
const broadcast = () => channel.postMessage('changed');
function statusText(id, text) {
  // Replacing identical live-region text can announce it again on every keystroke/render.
  if ($(id).textContent !== text) $(id).textContent = text;
}
function connectionStatus() {
  if (!accountId || !state) return;
  const needsAttention = state.queue.some(entry => entry.failure) || state.workspaceMove?.failure || !$('error').hidden;
  const pending = state.queue.length || state.workspaceMove;
  $('saveStatus').dataset.state = !navigator.onLine ? 'offline' : needsAttention ? 'error' : pending || syncing ? 'pending' : 'confirmed';
  const label = !navigator.onLine ? 'Working offline' : needsAttention ? 'Save needs attention' : state.workspaceMove ? 'Collection move pending' : state.queue.length ? `${state.queue.length} save(s) pending` : syncing ? 'Syncing with cloud' : state.workspaceErasureNotice ? 'Workspace permanently erased; local copies removed after sync' : 'Saved to cloud';
  $('saveStatus').title = label;
  statusText('connectionLabel', label);
  statusText('menuSyncState', !navigator.onLine ? 'Offline' : needsAttention ? 'Needs attention' : pending || syncing ? 'Pending' : 'Saved');
}
function error(message, kind = 'local') {
  $('error').hidden = false; statusText('error', message); $('error').dataset.kind = kind;
  if ($('editor').open) { $('editError').hidden = false; statusText('editError', message); }
  if ($('defaultsEditor').open || destination === 'preferences/task-options') { $('defaultsError').hidden = false; statusText('defaultsError', message); }
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
    defaults: defaultsEditing?.type === 'list' ? { ...defaultsEditing, values: formValues($('defaultsForm')) } : null,
    defaultsOpen: $('defaultsEditor').open, clarification: clarification.snapshot(), brief: briefs.snapshot(),
    day: $('day').value, navigation: structuredClone(navigation), review: reviews.draft(), extraction: extraction.snapshot(), recurrence: recurrence.snapshot(), projectPlanning: projectPlanning.snapshot() };
}
function preferenceDraft() {
  return defaultsEditing?.type === 'settings'
    ? { ...(state.preferenceDraft || {}), defaults: { ...defaultsEditing, values: formValues($('defaultsForm')) } }
    : state.preferenceDraft;
}
function storageFailure(failure) {
  error(`Could not save on this device: ${failure.message}. Your text has been kept. Copy or export it before leaving.`);
  statusText('draftStatus', 'Not saved on device');
  $('recovery').hidden = false;
  $('recoveryText').value = JSON.stringify({ accountId, draft: draft(), preferenceDraft: preferenceDraft(), localCopy: state }, null, 2);
  $('editor').close(); // Make the recovery copy outside the modal reachable.
  $('defaultsEditor').close();
  clarification.close();
  briefs.close();
  projectPlanning.close();
  extraction.close();
  $('recurringEditor').close();
}
function guard(action) {
  return (...args) => Promise.resolve().then(() => action(...args)).catch(failure => error(failure.message));
}
async function journal() {
  if (!accountId || switchingWorkspace || projected(state)['workspace:' + selectedWorkspace]?.deleted) return false;
  const owner = accountId, snapshot = draft();
  const preferenceDefaults = preferenceDraft()?.defaults;
  try {
    const saved = await transact(owner, local => {
      Object.assign(currentDraft(local), snapshot);
      if (preferenceDefaults) local.preferenceDraft = { ...(local.preferenceDraft || {}), defaults: preferenceDefaults };
    });
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
  const savedCapture = normalizeCaptureDraft(saved.capture);
  fillValues(capture, savedCapture);
  originalInput = savedCapture.original;
  extraction.restore(normalizeExtractionDraft(saved.extraction));
  $('previewHelp').hidden = originalInput === undefined;
  navigation = emptyNavigation();
  Object.assign(navigation.work, saved.navigation?.work);
  navigation.work.search = { ...defaultSearch(), ...(saved.navigation?.work?.search || {}) };
  Object.assign(navigation.lists, saved.navigation?.lists || {});
  Object.assign(navigation.plan, saved.navigation?.plan || {});
  Object.assign(navigation.execute, saved.navigation?.execute || {});
  $('day').value = saved.day ?? localDate(new Date().toISOString()).slice(0, 10);
  $('planDay').value = $('day').value;
  workspace(false);
  // Keep unfinished list creation available through New list without opening it on arrival.
  if (saved.edit) openEditor(saved.edit, false, saved.editOpen === true && !(saved.edit.type === 'list' && saved.edit.version === 0));
  else $('editor').close();
  if (saved.defaults) openDefaults(saved.defaults, false, saved.defaultsOpen === true);
  refreshOptions(); render();
  reviews.restore(saved.review);
  clarification.restore(saved.clarification);
  briefs.restore(saved.brief);
  projectPlanning.restore(saved.projectPlanning);
  recurrence.restore(saved.recurrence);
}
function button(text, handler, label = text, focusKey) {
  const element = document.createElement('button'); element.textContent = text;
  element.setAttribute('aria-label', label);
  if (focusKey) element.dataset.focusKey = focusKey;
  element.addEventListener('click', guard(handler)); return element;
}
const searchForm = $('searchForm'), savedViewForm = $('savedViewForm');
const stateLabel = status => ({ active: 'Active work', all: 'All retained work', archived: 'Archived', completed: 'Completed', reference: 'Reference', someday: 'Someday' })[status] || status;
function searchStatuses(records, selected = '') {
  const values = new Set(['inbox', 'next', 'waiting', 'deferred', 'someday', 'on-hold', 'reference', 'completed', 'dropped', 'draft', 'active']);
  for (const status of userDefaults().statuses || []) values.add(status);
  for (const record of Object.values(records)) {
    if (['item', 'project'].includes(record.type) && record.status) values.add(record.status);
    if (record.type === 'list') for (const status of record.defaults?.statuses || []) values.add(status);
  }
  if (selected.startsWith('status:')) values.add(selected.slice(7));
  return [...values].filter(Boolean).sort((left, right) => stateLabel(left).localeCompare(stateLabel(right)));
}
function searchStateOptions(select, records, selected) {
  const states = [['active', 'Active work'], ['all', 'All retained work'], ['archived', 'Archived'],
    ...searchStatuses(records, selected).map(status => [`status:${status}`, stateLabel(status)])];
  select.replaceChildren(...states.map(([value, label]) => new Option(label, value)));
  select.value = states.some(([value]) => value === selected) ? selected : 'active';
}
function currentSearch() {
  navigation.work.search = { ...defaultSearch(), ...(navigation.work.search || {}) };
  return navigation.work.search;
}
function setSearchControls(filters, records) {
  if (searchForm.elements.query.value !== filters.query) searchForm.elements.query.value = filters.query;
  searchForm.elements.resultType.value = filters.resultType;
  searchStateOptions(searchForm.elements.resultState, records, filters.resultState);
}
function savedViewFields(form = savedViewForm) {
  return { title: form.elements.title.value, workspaceId: selectedWorkspace, query: form.elements.query.value,
    resultType: form.elements.resultType.value, resultState: form.elements.resultState.value };
}
function openSavedView(record = null) {
  if (workspaceReadOnly()) throw new Error('Unarchive this workspace before changing saved views.');
  savedViewEditing = record;
  const filters = record || currentSearch();
  savedViewForm.reset();
  savedViewForm.elements.title.value = record?.title || '';
  savedViewForm.elements.query.value = filters.query;
  savedViewForm.elements.resultType.value = filters.resultType;
  searchStateOptions(savedViewForm.elements.resultState, scopedRecords(), filters.resultState);
  $('savedViewHeading').textContent = record ? 'Edit saved view' : 'Save current view';
  statusText('savedViewError', ''); showDialog($('savedViewEditor')); savedViewForm.elements.title.focus();
}
async function saveSavedView(record, action, fields) {
  const owner = accountId, generation = accountGeneration;
  if (!owner || workspaceReadOnly()) throw new Error('Unarchive this workspace before changing saved views.');
  const saved = await transact(owner, local => {
    if (local.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before changing a saved view.');
    const current = projected(local)[key(record)];
    if ((current?.version || 0) !== record.version || action === 'delete' && current?.deleted) throw new Error('This saved view changed. Review the latest version and try again.');
    queueMutations(local, owner, [{ type: 'savedView', id: record.id, action, expectedVersion: record.version, ...(fields ? { fields } : {}) }]);
  });
  if (owner !== accountId || generation !== accountGeneration) return;
  state = saved; render(); broadcast(); void sync();
}
function renderSearch(open, records) {
  $('searchWorkspace').hidden = !open;
  if (!open) return;
  const workspace = availableWorkspaces().find(space => space.id === selectedWorkspace);
  $('searchHeading').textContent = `Search ${workspace?.title || 'workspace'}`;
  const filters = currentSearch(); setSearchControls(filters, records);
  const readOnly = workspaceReadOnly(); $('saveSearchView').disabled = readOnly;
  const views = Object.values(records).filter(record => record.type === 'savedView' && !record.deleted)
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  $('savedViewEntries').replaceChildren(...views.map(record => {
    const article = document.createElement('article'), summary = document.createElement('p'), actions = document.createElement('div');
    article.className = 'saved-view-row'; summary.textContent = `${record.title} · “${record.query}” · ${record.resultType} · ${stateLabel(record.resultState.replace(/^status:/, ''))}`;
    actions.className = 'actions';
    const apply = button('Apply', () => {
      navigation.work.search = { query: record.query, resultType: record.resultType, resultState: record.resultState };
      render(); void journal(); searchForm.elements.query.focus();
    }, `Apply saved view ${record.title}`, `savedView:${record.id}:apply`);
    const editView = button('Edit', () => openSavedView(record), `Edit saved view ${record.title}`, `savedView:${record.id}:edit`);
    const remove = button('Delete', async () => {
      if (!confirm(`Delete saved view “${record.title}”? Matching records stay unchanged.`)) return;
      await saveSavedView(record, 'delete'); statusText('searchStatus', `Deleted saved view “${record.title}”. Matching records were not changed.`);
    }, `Delete saved view ${record.title}`, `savedView:${record.id}:delete`);
    editView.disabled = remove.disabled = readOnly; remove.dataset.focusFallback = 'search:heading';
    actions.append(apply, editView, remove); article.append(summary, actions); return article;
  }));
  if (!views.length) $('savedViewEntries').textContent = 'No saved views in this workspace.';
  const results = searchWorkspace(records, filters);
  $('searchResults').replaceChildren(...results.map(record => {
    const article = document.createElement('article'), heading = document.createElement('h4'), notes = document.createElement('p'), metadata = document.createElement('p');
    article.className = 'search-result'; article.dataset.recordKey = key(record);
    const openRecord = button(record.title || record.id, () => openEditor(record), `Open ${record.type} ${record.id}: ${record.title || 'Untitled'}`, `search:${key(record)}:open`);
    openRecord.className = 'editable-title'; heading.append(openRecord);
    const paths = collectionPaths(record, records);
    metadata.className = 'muted'; metadata.textContent = [`${record.type} · ID ${record.id}`, record.status, ...paths].filter(Boolean).join(' · ');
    notes.textContent = record.outcome || record.description || '';
    article.append(heading, metadata, notes); return article;
  }));
  statusText('searchStatus', `${results.length} result${results.length === 1 ? '' : 's'} in ${workspace?.title || 'this workspace'} on this device.`);
  if (!results.length) $('searchResults').textContent = 'No retained records match this query and filters. Reset search to return to active work.';
}
function archivedLink() {
  const link = document.createElement('a'); link.href = '#lists'; link.textContent = 'Archived collections'; link.className = 'button';
  link.onclick = () => { navigation.lists.view = '@archived'; };
  return link;
}
const taskIcons = {
  complete: ['M5 12l4 4L19 6'],
  reopen: ['M4 10h11a5 5 0 0 1 0 10h-1', 'M4 10l4-4M4 10l4 4'],
  clarify: ['M9.1 9a3 3 0 1 1 5.1 2.1c-1.2 1.2-2.2 1.7-2.2 3.4', 'M12 18h.01', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z'],
  brief: ['M3 8h18v12H3V8Z', 'M8 8V5h8v3', 'M3 13h18'],
  delete: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 10v6M14 10v6'],
  undo: ['M4 10h11a5 5 0 0 1 0 10h-1', 'M4 10l4-4M4 10l4 4']
};
function taskIcon(control, name, title) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('task-icon'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const data of taskIcons[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', data); svg.append(path);
  }
  control.replaceChildren(svg); control.classList.add('icon-button'); control.title = title; return control;
}
function render() {
  if (!accountId || !state) return;
  const focused = document.activeElement;
  const recordMap = scopedRecords();
  const records = Object.values(recordMap).filter(record => !record.deleted);
  const lists = records.filter(record => record.type === 'list' && !isEffectivelyArchived(record, recordMap));
  const projects = records.filter(record => record.type === 'project' && !isEffectivelyArchived(record, recordMap));
  const archivedCount = records.filter(record => isCollection(record) && record.archived).length;
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
  options(edit.elements.listId, moving ? [] : lists, [['', 'No list']], !moving);
  options(edit.elements.projectId, moving ? [] : projects, [['', 'No project']], !moving);
  const listMode = destination === 'lists';
  recurrence.refresh(listMode);
  const filters = navigation[listMode ? 'lists' : 'work'];
  options($('view'), [...lists.map(record => ({ ...record, title: collectionLabel(record) })), ...projects.map(project => ({ id: `project:${project.id}`, title: collectionLabel(project) }))],
    listMode ? [['', 'Choose collection'], ['@archived', `Archived collections (${archivedCount})`]] : [['inbox', 'Inbox (unprocessed)'], ['all', 'All items'], ['unfiled', 'No list'], ['day', 'Planned day'], ['@search', 'Search workspace']]);
  $('view').value = [...$('view').options].some(option => option.value === filters.view) ? filters.view : listMode ? '' : 'inbox';
  filters.view = $('view').value;
  $('collectionBrowser').hidden = !listMode;
  $('clarifyInbox').hidden = listMode;
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
  statusText('syncStatus', state.workspaceMove
    ? `Collection move ${state.workspaceMove.failure || state.queue.some(entry => entry.workspaceMoveId && entry.failure) ? 'paused — review and resume it.' : 'saved on device — pending server confirmation.'}`
    : state.queue.length ? `${state.queue.length} save(s) on device — ${state.queue.some(entry => entry.failure) ? 'failed / needs attention' : 'pending server confirmation'}.` : 'All saved work is server-confirmed.');
  connectionStatus();
  $('lists').replaceChildren(...lists.filter(list => listMode && list.id === filters.view).flatMap(list => [titleButton(list, `Edit list: ${list.title}`), button('Defaults', () => openDefaults(list), `Defaults: ${list.title}`, `${key(list)}:defaults`), deleteButton(list)]));
  const view = $('view').value;
  const archiveMode = listMode && view === '@archived';
  const searchMode = !listMode && view === '@search';
  $('listTools').hidden = !listMode || archiveMode;
  $('recurringSection').hidden = !listMode || archiveMode;
  $('clarifyInbox').hidden = listMode || searchMode;
  $('statusFilter').closest('label').hidden = archiveMode || searchMode;
  $('statusSelection').hidden = archiveMode || searchMode || $('statusSelection').hidden;
  $('executionFilters').hidden = !listMode || archiveMode;
  $('items').hidden = archiveMode || searchMode;
  $('dayLabel').hidden = view !== 'day';
  const project = projects.find(project => view === `project:${project.id}`);
  const context = project || lists.find(list => list.id === view);
  renderArchive(view === '@archived', recordMap);
  renderSearch(searchMode, recordMap);
  $('collectionBreadcrumbs').textContent = context ? ancestry(context, scopedRecords()).reverse().map(ref => scopedRecords()[refKey(ref)]?.title || 'Unavailable parent').join(' / ') : archiveMode ? 'Archived history for this workspace.' : 'Choose a collection.';
  $('collectionChildren').replaceChildren(...(listMode && context ? records.filter(record => isCollection(record) && !isEffectivelyArchived(record, recordMap) && record.parentRef && refKey(record.parentRef) === key(context)).map(child => button(collectionLabel(child), () => { navigation.lists.view = viewKey(child); render(); void journal(); }, `Open ${collectionLabel(child)}`, `child:${key(child)}`)) : []));
  renderCollectionSettings(context, records, listMode && !archiveMode);
  $('addContextItem').hidden = !context;
  $('addContextItem').disabled = workspaceReadOnly();
  $('addContextItem').textContent = project ? 'Add next action' : 'Add item';
  $('addContextItem').onclick = guard(() => addContextItem(context));
  $('projectOutcome').hidden = !project;
  $('projectOutcome').textContent = project ? `Project status: ${project.status === 'draft' ? 'Needs outcome' : project.status} · Desired outcome: ${project.outcome || 'Not supplied yet'} · ${records.filter(record => record.type === 'item' && !archiveOnly(record, recordMap) && record.status === 'next' && belongsTo(record, project)).length} next action(s)` : '';
  $('projectActions').replaceChildren(...(project ? [titleButton(project, `Edit project: ${project.title}`), button('Plan project', () => projectPlanning.open(project), `Plan project ${project.title}`, `${key(project)}:plan`), button('Brief', () => briefs.open(project), `Brief ${project.title}`, `${key(project)}:brief`), deleteButton(project)] : []));
  $('items').replaceChildren(...records.filter(record => {
    if (record.type !== 'item') return false;
    if (archiveOnly(record, recordMap)) return false;
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
    const article = document.createElement('article'); article.className = 'task-row'; article.dataset.id = record.id;
    const title = document.createElement('h3');
    if (record.recurrenceTemplateId && record.occurrenceState !== 'open') title.textContent = record.title;
    else title.append(titleButton(record));
    const notes = document.createElement('p'); notes.className = 'notes'; notes.textContent = record.description;
    const metadata = document.createElement('p'); metadata.className = 'notes';
    metadata.textContent = [...(record.contexts || []), ...(record.areas || []), record.energy, record.timeRequired, record.priority].filter(Boolean).join(' · ');
    for (const ref of memberships(record)) {
      const collection = recordMap[refKey(ref)], archived = archivedAncestor(ref, recordMap);
      metadata.append(` · ${collection ? collectionLabel(collection) : 'Unavailable collection: ' + refKey(ref)}${archived ? ` (Archived with ${archived.title})` : ''}`);
    }
    if (record.plannedDay) metadata.append(` · Planned: ${record.plannedDay}`);
    if (record.recurrenceTemplateId) metadata.append(` · Repeats · intended ${record.intendedDate}`);
    if (record.dueDateUtc) { const time = document.createElement('time'); time.dateTime = record.dueDateUtc; time.textContent = ` Due ${new Date(record.dueDateUtc).toLocaleString()}`; metadata.append(time); }
    for (const [name, label] of [['dueDate', 'Deadline'], ['waitingOn', 'Waiting for'], ['startDate', 'Deferred until'], ['startDateUtc', 'Deferred until'], ['reviewDate', 'Review on'], ['reviewDateUtc', 'Review on']]) {
      if (record[name]) metadata.append(` · ${label}: ${name.endsWith('Utc') ? new Date(record[name]).toLocaleString() : record[name]}`);
    }
    if (reviewReady(record)) metadata.append(' · Ready for review — choose Next or set a new date');
    const status = document.createElement('p'); status.className = 'record-state'; status.dataset.pending = String(!!record.localState);
    status.textContent = [record.status, record.localState].filter(Boolean).join(' · ');
    const content = document.createElement('div'); content.className = 'task-content'; content.append(title, notes, metadata, status);
    const actions = document.createElement('div'); actions.className = 'task-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', `Actions for ${record.title}`);
    const action = record.status === 'completed' ? 'Reopen' : 'Complete';
    if (record.recurrenceTemplateId) {
      const template = scopedRecords()[`recurrenceTemplate:${record.recurrenceTemplateId}`];
      if (record.occurrenceState === 'open') {
        actions.append(taskIcon(button('', () => resolveOccurrence(record, 'completed'), `Complete ${record.title}`, `${key(record)}:complete`), 'complete', 'Complete'));
        actions.append(button('Skip occurrence', () => resolveOccurrence(record, 'skipped'), `Skip occurrence ${record.title}`, `${key(record)}:skip`));
      }
      if (template) actions.append(button('Template & history', () => recurrence.open(template), `Open recurring template and history for ${record.title}`, `${key(record)}:template`));
    } else if (record.status !== 'reference') actions.append(taskIcon(button('', () => updateRecord(record, { status: record.status === 'completed' ? record.statusBeforeCompletion || 'next' : 'completed' }), `${action} ${record.title}`, `${key(record)}:complete`), record.status === 'completed' ? 'reopen' : 'complete', action));
    if (!record.recurrenceTemplateId || record.occurrenceState === 'open') actions.append(taskIcon(button('', () => clarification.open(record), `Clarify ${record.title}`, `${key(record)}:clarify`), 'clarify', 'Clarify'));
    if ((!record.recurrenceTemplateId || record.occurrenceState === 'open') && record.status !== 'reference') actions.append(taskIcon(button('', () => briefs.open(record), `Brief ${record.title}`, `${key(record)}:brief`), 'brief', 'Brief'));
    if (!record.recurrenceTemplateId) actions.append(taskIcon(deleteButton(record), 'delete', 'Delete'));
    if (!record.recurrenceTemplateId && record.workflowBeforeTransition) actions.append(taskIcon(button('', () => updateRecord(record, record.workflowBeforeTransition), `Undo state change ${record.title}`, `${key(record)}:undo`), 'undo', 'Undo state change'));
    article.append(content, actions); return article;
  }));
  if (!$('items').childElementCount) {
    $('items').textContent = listMode && !view
      ? (lists.length ? 'Choose a collection to see its items and manage its details.' : 'No collections yet. Create one with New list, or use Capture without one.')
      : executionCount ? 'No items match this view. Reset context, time & energy to broaden your choices, or change View or Status.'
      : view === 'inbox' ? 'No unprocessed captures match this view. Check Status for additional filters, or use Capture to add work.'
      : context ? `No items match this view. Choose Completed or All statuses to see finished work, or use ${project ? 'Add next action' : 'Add item'} to add work here.`
      : 'No items match this view. Choose Completed or All statuses to see finished work, or use Capture to add work.';
    if (archivedCount && !archiveMode) $('items').append(' ', archivedLink());
  }
  const failed = state.queue[0]?.failure ? state.queue[0] : null;
  const moveFailure = state.workspaceMove?.failure;
  const projectPlanFailure = failed?.operation.mutations.some(mutation => mutation.type === 'projectPlanRevision');
  $('failure').hidden = !failed && !moveFailure;
  $('resumeMove').hidden = !state.workspaceMove || !failed?.workspaceMoveId && !moveFailure;
  $('recoverProjectPlan').hidden = !projectPlanFailure;
  if (failed || moveFailure) {
    $('failureMessage').textContent = failed?.failure || moveFailure;
    const describe = record => !record ? 'No server record' : record.deleted ? 'Deleted on server' :
      [['content', 'Brief content'], ['subjectType', 'Brief source type'], ['subjectId', 'Brief source ID'], ['sourceVersion', 'Brief source version'], ['previousBriefId', 'Previous brief revision'], ['step', 'Clarification step'], ['decision', 'Clarification decision'], ['answers', 'Accepted answers / unknowns'], ['proposal', 'Unaccepted proposal'], ['reviewKind', 'Review kind'], ['included', 'Included records'], ['decisionHeads', 'Latest decisions'], ['decisionCount', 'History entries'], ['reviewId', 'Review'], ['previousReflectionId', 'Previous reflection'], ['promptVersion', 'Prompt version'], ['prompts', 'Prompts'], ['conclusion', 'Conclusion'], ['followUpIds', 'Follow-up actions'], ['sequence', 'Decision sequence'], ['index', 'Reviewed record index'], ['choice', 'Decision'], ['recordVersion', 'Reviewed record version'], ['before', 'Prior workflow / plan'], ['after', 'Resulting plan'], ['changes', 'Workflow changes'], ['estimationMethod', 'Estimation method'], ['actionIds', 'Numbered order'], ['loadAssessment', 'Load assessment'], ['carryoverDecisions', 'Carryover decisions'], ['estimates', 'Tagged estimates'], ['collectionRefs', 'Memberships'], ['parentRef', 'Parent'], ['kind', 'Kind'], ['archived', 'Archived'], ['revisitDate', 'Revisit on'], ['title', 'Title'], ['query', 'Search'], ['resultType', 'Result type'], ['resultState', 'Result state'], ['description', 'Notes'], ['outcome', 'Desired outcome'], ['projectId', 'Project ID'], ['plannedDay', 'Planned day'], ['plannedWeek', 'Planned week'], ['status', 'Status'], ['waitingOn', 'Waiting for'], ['startDate', 'Deferred until'], ['startDateUtc', 'Deferred until (UTC)'], ['reviewDate', 'Review on'], ['reviewDateUtc', 'Review on (UTC)'], ['dueDate', 'Deadline'], ['listId', 'List'], ['defaults', 'Defaults'], ['dueDateUtc', 'Due'], ['contexts', 'Contexts'], ['areas', 'Areas'], ['energy', 'Energy'], ['timeRequired', 'Time required'], ['effortEstimate', 'Effort estimate'], ['priority', 'Priority'], ['referenceLinks', 'Reference links'], ['rule', 'Recurrence rule'], ['paused', 'Paused'], ['tombstoned', 'Stopped'], ['nextOccurrenceNumber', 'Next occurrence number'], ['nextIntendedDate', 'Next intended date'], ['openOccurrenceId', 'Open occurrence'], ['lastResolvedUtc', 'Last resolved'], ['recurrenceTemplateId', 'Recurring template'], ['recurrenceNumber', 'Occurrence number'], ['intendedDate', 'Intended date'], ['sourceTemplateVersion', 'Source template version'], ['occurrenceState', 'Occurrence state'], ['occurrenceResolvedUtc', 'Occurrence resolved']]
        .filter(([field]) => field in record).map(([field, label]) => `${label}: ${field === 'listId' ? lists.find(list => list.id === record[field])?.title || 'No list / unavailable list' : typeof record[field] === 'object' ? JSON.stringify(record[field], null, 2) : record[field]}`).join('\n');
    const planConflict = failed?.receipt && failed.operation.mutations.some(mutation => mutation.type === 'dailyPlan');
    const reflectionConflict = failed?.receipt && failed.operation.mutations.some(mutation => mutation.type === 'reviewReflection');
    if (projectPlanFailure) {
      const pending = failed.operation.mutations.find(mutation => mutation.type === 'projectPlanRevision').fields;
      const project = state.records[`project:${pending.projectId}`];
      const accepted = project?.planningHeadId && state.records[`projectPlanRevision:${project.planningHeadId}`];
      const describeProjectPlan = revision => revision ? [
        `Purpose & principles: ${revision.sections.purposePrinciples || '(blank)'}`,
        `Desired evidence: ${revision.sections.desiredEvidence || '(blank)'}`,
        `Organization / approach: ${revision.sections.organizationApproach || '(blank)'}`,
        `Unresolved questions: ${revision.sections.unresolvedQuestions || '(blank)'}`,
        `Candidates: ${revision.candidates.map(candidate => `${candidate.title} [${candidate.kind}]`).join('; ') || '(none)'}`
      ].join('\n') : 'No accepted project plan';
      $('comparison').textContent = `My pending plan\n${describeProjectPlan(pending)}\n\nLatest accepted plan\n${describeProjectPlan(accepted)}`;
    } else if (planConflict) {
      const projectedRecords = projected(state);
      const describePlan = (record, revision, pending) => {
        if (!record) return 'No plan';
        const workspaceId = record.workspaceId || revision?.fields?.workspaceId;
        const ids = record.actionIds || [], method = (pending ? projectedRecords : state.records)[`planPreference:${workspaceId}`]?.estimationMethod || 'none';
        const estimates = pending ? revision?.fields?.estimates || [] : ids.map(actionId => ({ actionId, estimate: state.records[`item:${actionId}`]?.effortEstimate || null }));
        const order = ids.map((id, index) => `${index + 1}. ${(pending ? projectedRecords : state.records)[`item:${id}`]?.title || id}`).join('\n') || '(empty)';
        return `Estimation method: ${method}\nLoad assessment: ${record.loadAssessment}\nOrder:\n${order}\nTagged estimates: ${JSON.stringify(estimates)}\nCarryover decisions: ${JSON.stringify(record.carryoverDecisions || [])}`;
      };
      $('comparison').textContent = failed.operation.mutations.filter(mutation => mutation.type === 'dailyPlan').map(mutation => {
        const revision = failed.operation.mutations.find(candidate => candidate.type === 'dailyPlanRevision' && candidate.fields.planId === mutation.id);
        return `My pending plan\n${describePlan(mutation.fields, revision, true)}\n\nServer plan\n${describePlan(state.records[key(mutation)], null, false)}`;
      }).join('\n\n——\n\n');
    } else $('comparison').textContent = failed ? failed.operation.mutations.map(mutation =>
      `Pending ${mutation.type}\n${describe(mutation.fields)}\n\nServer version\n${describe(state.records[key(mutation)])}`).join('\n\n——\n\n')
      : 'The move plan and its acknowledged progress remain saved on this device.';
    const move = !!state.workspaceMove && (!!failed?.workspaceMoveId || !!moveFailure);
    const recurrenceConflict = failed?.operation.mutations.some(mutation => mutation.type === 'recurrenceTemplate' || mutation.fields?.recurrenceTemplateId);
    $('resolve').hidden = projectPlanFailure || move || recurrenceConflict || !failed?.receipt || !planConflict && !reflectionConflict && failed.operation.mutations.some(mutation => ['review', 'brief'].includes(mutation.type) || mutation.action !== 'update' || !state.records[key(mutation)] || state.records[key(mutation)].deleted);
    $('resolve').textContent = planConflict ? 'Apply my pending plan to latest version' : reflectionConflict ? 'Merge pending reflection after accepted snapshot' : 'Apply pending edit to latest version';
    $('discard').hidden = move;
    $('discard').textContent = failed?.receipt ? 'Use server version for this save' : 'Remove this rejected save';
  }
  reviews.render();
  briefs.render();
  projectPlanning.render();
  renderDeleted();
  renderEditorDraft();
  $('planDay').value = $('day').value;
  planner.render();
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
  const executeItems = records.filter(record => executeCollection && record.type === 'item' && !archiveOnly(record, recordMap) && belongsTo(record, executeCollection));
  const readyItems = executeItems.filter(readyToExecute);
  $('executeItems').replaceChildren(...readyItems.filter(record => matchesExecutionFilters(record, execute)).map(record => {
    const article = document.createElement('article'); article.className = 'execute-item'; article.dataset.id = record.id;
    const checkLabel = document.createElement('label'); checkLabel.className = 'execute-check';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.disabled = readOnly;
    checkbox.setAttribute('aria-label', `Complete ${record.title}`); checkbox.dataset.focusKey = `${key(record)}:execute-complete`;
    checkbox.addEventListener('change', guard(async () => {
      checkbox.disabled = true;
      try { await (record.recurrenceTemplateId ? resolveOccurrence(record, 'completed') : updateRecord(record, { status: 'completed' })); }
      finally { if (checkbox.isConnected) { checkbox.checked = false; checkbox.disabled = !accountId || workspaceReadOnly(); } }
    }));
    const title = titleButton(record); title.dataset.focusKey = `${key(record)}:execute-edit`; title.disabled = readOnly;
    checkLabel.append(checkbox); article.append(checkLabel, title); return article;
  }));
  if (!$('executeItems').childElementCount) $('executeItems').textContent = execute.view
    ? readyItems.length && executeFilterCount ? 'No ready items match these filters. Reset context, time & energy to see more.' : `No ready items in this ${execute.kind}. Inspect saved work in Organize, or choose another ${execute.kind}.`
    : executeCollections.length ? `Choose a ${execute.kind} to start working through its items.` : `No ${execute.kind}s yet. Create one in Organize.`;
  if (!$('executeItems').querySelector('article') && archivedCount) $('executeItems').append(' ', archivedLink());
  $('capture').hidden = !!projected(state)['workspace:' + selectedWorkspace]?.deleted;
  $('captureAI').hidden = readOnly;
  if (readOnly) { extraction.suspend(); $('editor').close(); $('defaultsEditor').close(); clarification.close(); briefs.close(); }
  $('captureWorkspaceFields').disabled = readOnly;
  $('reviewWorkspaceFields').disabled = readOnly;
  $('newList').disabled = readOnly;
  if (readOnly) document.querySelectorAll('#items button, #lists button, #projectActions button, #deletedItems button').forEach(control => { control.disabled = true; });
  if (!focused.isConnected || (focused !== document.body && !focused.getClientRects().length)) restoreFocus(focused);
}
function deleteButton(record) {
  return button('Delete', async () => {
    const linked = record.type === 'list' ? Object.values(scopedRecords()).filter(item => item.type === 'item' && !item.recurrenceTemplateId && !item.deleted && belongsTo(item, record)) : [];
    const pending = linked.filter(item => item.status !== 'completed').length;
    if (pending && !confirm(`Delete “${record.title}”? This list has ${pending} uncompleted item${pending === 1 ? '' : 's'}. Its ${linked.length} linked item${linked.length === 1 ? '' : 's'} will also be marked deleted. Cancel to review the pending items.`)) return;
    await changeDeletion(record, 'delete', linked.map(item => `${key(item)}:${item.version}`).sort());
  }, `Delete ${record.type}: ${record.title}`, `${key(record)}:delete`);
}
async function resolveOccurrence(record, outcome) {
  const template = scopedRecords()[`recurrenceTemplate:${record.recurrenceTemplateId}`];
  if (!template) throw new Error('The recurring template is unavailable. Sync and open its history before resolving this occurrence.');
  if (outcome === 'skipped' && !confirm('Skip this occurrence? Skipping keeps the series going from today.')) return;
  await saveRecurrence(resolveOccurrenceMutations(record, template, outcome), outcome === 'completed' ? 'Occurrence completed; the next date is scheduled.' : 'Occurrence skipped; the series continues from today.');
}
function renderDeleted() {
  statusText('deletedStatus', state.queue.length ? 'Device changes are pending server confirmation. Check Sync status for failures.' : 'All saved work is server-confirmed.');
  const deleted = Object.values(scopedRecords()).filter(record => record.deleted && ['item', 'list', 'project'].includes(record.type));
  $('deletedItems').replaceChildren(...deleted.map(record => {
    const article = document.createElement('article'), title = document.createElement('h3'), status = document.createElement('p');
    title.textContent = `${record.type}: ${record.title}`;
    status.textContent = record.localState || 'Deletion server-confirmed';
    const conversion = record.type === 'item' && Object.values(scopedRecords()).find(entry => entry.type === 'clarification' && entry.id === record.id && entry.step === 'complete' && entry.decision?.type === 'convert');
    article.append(title, status, conversion
      ? button('Undo conversion in Clarify', () => clarification.open(record), `Undo conversion of ${record.title}`, `${key(record)}:restore`)
      : button('Restore', () => changeDeletion(record, 'restore'), `Restore ${record.type}: ${record.title}`, `${key(record)}:restore`));
    return article;
  }));
  if (workspaceReadOnly()) $('deletedItems').querySelectorAll('button').forEach(control => { control.disabled = true; });
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
      const linked = Object.values(records).filter(item => item.type === 'item' && !item.recurrenceTemplateId && !item.deleted && belongsTo(item, record));
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
  openEditor({ type: 'item', id: crypto.randomUUID(), version: 0, title: '', description: '', workspaceId: selectedWorkspace,
    collectionRefs: [target],
    listId: target.type === 'list' ? target.id : null,
    projectId: target.type === 'project' ? target.id : null,
    status: target.type === 'project' ? 'next' : 'inbox' });
  $('createdDestination').replaceChildren();
}
function openEditor(record, focus = true, show = true) {
  if (record.fields && (!record.initialFields || typeof record.initialFields !== 'object' || Array.isArray(record.initialFields))) {
    throw new Error('This editor draft has no saved baseline. Export a device copy before clearing unsupported development data.');
  }
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
  const fields = record.fields ? { ...record.fields, parentRef: record.fields.parentRef ? parseRef(record.fields.parentRef) : null,
    status: record.type === 'project' ? record.fields.projectStatus : record.fields.status } : record;
  edit.elements.title.value = fields.title;
  edit.elements.description.value = fields.description || '';
  edit.elements.listId.value = fields.listId || '';
  pickerOptions(editOrganizer, scopedRecords(), memberships(fields));
  $('editOrganizer').hidden = record.type !== 'item';
  $('editCollectionFields').hidden = !isCollection(record) || record.version > 0;
  edit.elements.kind.value = collectionKind(record);
  for (const option of edit.elements.kind.options) option.disabled = !!record.version && (record.type === 'project' ? option.value !== 'project' : option.value === 'project');
  const scoped = scopedRecords();
  const parentOptions = Object.values(scoped).filter(candidate => isCollection(candidate) && !candidate.deleted && !isEffectivelyArchived(candidate, scoped) && !ancestry(candidate, scoped).some(ref => refKey(ref) === key(record)));
  options(edit.elements.parentRef, parentOptions.map(candidate => ({ id: refKey(candidate), title: collectionLabel(candidate) })), [['', 'No parent']], true);
  edit.elements.parentRef.value = fields.parentRef ? refKey(fields.parentRef) : '';
  edit.elements.parentRef.disabled = false;
  options(edit.elements.workspaceId, availableWorkspaces().filter(space => !space.archived), []);
  edit.elements.workspaceId.value = fields.workspaceId;
  $('editWorkspaceLabel').hidden = false;
  $('editWorkspaceHelp').textContent = record.type === 'item'
    ? 'Moving clears collection memberships; the original text and item history move with it.'
    : 'Moving carries nested collections and linked items, including their history. Links to collections left behind are cleared.';
  const recurringOpen = record.type === 'item' && fields.recurrenceTemplateId && fields.occurrenceState === 'open';
  $('recurrenceEditScope').hidden = !recurringOpen;
  edit.elements.workspaceId.disabled = !!recurringOpen;
  refreshOptions();
  fillValues(edit, { ...fields, projectStatus: record.type === 'project' ? fields.status : 'active', parentRef: fields.parentRef ? refKey(fields.parentRef) : '', kind: collectionKind(fields), collectionRefs: record.type === 'item' ? memberships(fields) : [], dueLocal: fields.dueLocal ?? localDate(fields.dueDateUtc), status: record.type === 'item' ? fields.status : 'inbox' });
  editing.initialFields = record.fields ? structuredClone(record.initialFields) : formValues(edit);
  if (record.fields) fillValues(edit, record.fields);
  $('editListLabel').hidden = record.type !== 'item';
  $('editAdvanced').hidden = record.type !== 'item';
  $('editProjectLifecycle').hidden = record.type !== 'project';
  $('editOutcomeLabel').hidden = record.type !== 'project';
  edit.elements.outcome.required = record.type === 'project' && fields.status !== 'draft';
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
  if (!owner) return false;
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
      const movingCollection = current && isCollection(current) && fields.workspaceId && fields.workspaceId !== current.workspaceId;
      if (movingCollection) {
        const records = projected(local), plan = collectionMovePlan(current, fields.workspaceId, records, fields);
        if (plan) beginCollectionMove(local, owner, plan);
        else enqueue(local, owner, collectionMoveMutations(current, fields.workspaceId, records, fields));
      } else {
        const mutation = { type: record.type, id: record.id, action: record.version === 0 ? 'create' : 'update', expectedVersion: record.version, fields };
        const planning = current?.type === 'item' && Object.hasOwn(fields, 'plannedDay')
          ? membershipPlanMutations(projected(local), current.workspaceId, current, fields.plannedDay) : [];
        const complete = [mutation, ...planning];
        ensurePlanMutationsAvailable(local, complete);
        enqueue(local, owner, complete);
      }
      if (close && current && record.version > 0 && !movingCollection) rememberEdit(local, current, fields);
      if (close) currentDraft(local).edit = null;
    });
    if (owner === accountId) state = saved;
  } catch (failure) { if (owner === accountId) storageFailure(failure); return false; }
  if (owner !== accountId) return false;
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
  broadcast(); void sync(); return true;
}

function clearSplitFeedback() {
  clearTimeout(splitFeedbackTimer); splitFeedbackTimer = undefined;
  statusText('splitStatus', ''); $('splitStatus').hidden = true;
}
capture.addEventListener('input', () => { clearSplitFeedback(); extraction.changed(); void journal(); });
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
      const mutations = captureMutations(submitted, selectedWorkspace);
      const details = taskFields({ ...submitted, projectId: !submitted.newList?.trim() && submitted.listId?.startsWith('project:') ? submitted.listId.slice(8) : null });
      for (const mutation of mutations) {
        if (mutation.type === 'item') Object.assign(mutation.fields, details, { status: 'inbox' });
        else mutation.fields.defaults = structuredClone(userDefaults());
      }
      let pendingSaves;
      const saved = await transact(owner, local => {
        pendingSaves = enqueueCapture(local, owner, mutations);
        if (JSON.stringify(normalizeCaptureDraft(currentDraft(local).capture)) === JSON.stringify(submitted)) { currentDraft(local).capture = {}; currentDraft(local).extraction = { enabled: currentDraft(local).extraction?.enabled === true, includeLists: currentDraft(local).extraction?.includeLists === true }; }
      });
      if (owner !== accountId) return;
      state = saved;
      if (JSON.stringify(captureDraft()) === JSON.stringify(submitted)) {
        capture.reset(); originalInput = undefined; $('previewHelp').hidden = true;
        extraction.reset(true);
      }
      const itemCount = mutations.filter(mutation => mutation.type === 'item').length;
      clearError(); statusText('draftStatus', `Saved ${itemCount} item${itemCount === 1 ? '' : 's'} on this device in ${pendingSaves} pending save${pendingSaves === 1 ? '' : 's'}.`);
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
  let fields, recurrenceManagedFields, recurrenceScope;
  try {
    const values = formValues(edit);
    fields = { title: values.title, description: values.description,
      ...(editing.type === 'item' ? { workspaceId: values.workspaceId, collectionRefs: values.collectionRefs, listId: values.listId || null, ...taskFields(values, editing.initialFields) } : { workspaceId: values.workspaceId, parentRef: values.parentRef ? parseRef(values.parentRef) : null, ...(editing.type === 'project' ? { outcome: values.outcome, status: values.projectStatus } : { kind: values.kind }) }) };
    const current = projected(state)[key(editing)];
    if (current?.recurrenceTemplateId && current.occurrenceState === 'open') {
      recurrenceScope = edit.elements.recurrenceScope.value;
      recurrenceManagedFields = Object.fromEntries(['title', 'description', 'workspaceId', 'collectionRefs', 'listId', 'projectId', 'status', 'contexts', 'areas', 'energy', 'timeRequired', 'priority', 'referenceLinks']
        .map(name => [name, structuredClone(fields[name] ?? current[name] ?? (['collectionRefs', 'contexts', 'areas'].includes(name) ? [] : null))]));
    }
    if (editing.version === 0 && editing.type === 'list') fields.defaults = structuredClone(userDefaults());
    else if (editing.version > 0) {
      const initial = { ...editing.initialFields, parentRef: editing.initialFields.parentRef ? parseRef(editing.initialFields.parentRef) : null, ...taskFields(editing.initialFields, editing.initialFields), listId: editing.initialFields.listId || null, ...(editing.type === 'project' ? { status: editing.initialFields.projectStatus } : {}) };
      fields = Object.fromEntries(Object.entries(fields).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(initial[name])));
      if (!Object.keys(fields).length && (!recurrenceScope || recurrenceScope === 'one')) { void discardEdit(); return; }
    }
  } catch (failure) { saving = false; error(failure.message); return; }
  // Keep the submitted form stable until its local transaction commits.
  const controls = [...edit.elements]; controls.forEach(control => { control.disabled = true; });
  void (recurrenceScope && recurrenceScope !== 'one' ? updateRecurringScope(editing, fields, recurrenceManagedFields, recurrenceScope) : updateRecord(editing, fields, true)).catch(failure => error(failure.message)).finally(() => {
    saving = false; controls.forEach(control => { control.disabled = false; });
  });
});
async function updateRecurringScope(record, itemFields, managedFields, scope) {
  const item = projected(state)[key(record)], template = item && scopedRecords()[`recurrenceTemplate:${item.recurrenceTemplateId}`];
  if (!item || !template || item.occurrenceState !== 'open') throw new Error('This recurring occurrence changed. Reopen it before choosing an edit scope.');
  if (!['inbox', 'next'].includes(managedFields.status)) throw new Error('Future recurring occurrences must be generated as Inbox or Next.');
  const templateFields = Object.fromEntries(Object.entries(managedFields).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(template[name])));
  const mutations = [];
  if (scope === 'this-future' && Object.keys(itemFields).length) mutations.push({ type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: itemFields });
  if (Object.keys(templateFields).length) mutations.push({ type: 'recurrenceTemplate', id: template.id, action: 'update', expectedVersion: template.version, fields: templateFields });
  if (!mutations.length) { await discardEdit(); return; }
  await saveRecurrence(mutations, scope === 'future' ? 'Future occurrences updated; this occurrence is unchanged.' : 'This and future occurrences updated.');
  editing = null; $('editor').close();
  const owner = accountId; if (owner) state = await transact(owner, local => { currentDraft(local).edit = null; currentDraft(local).editOpen = false; });
  render();
}
$('previewSplit').onclick = () => {
  if (!/[,;]/.test(capture.elements.text.value)) {
    clearSplitFeedback();
    statusText('splitStatus', 'No commas or semicolons found in the capture box.'); $('splitStatus').hidden = false;
    splitFeedbackTimer = setTimeout(clearSplitFeedback, 5000);
    capture.elements.text.focus(); return;
  }
  clearSplitFeedback();
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
  const saved = await transact(owner, local => {
    const undo = local.undoEdit, current = undo && projected(local)[key(undo)];
    const planning = current?.type === 'item' && Object.hasOwn(undo.fields || {}, 'plannedDay')
      ? membershipPlanMutations(projected(local), current.workspaceId, current, undo.fields.plannedDay) : [];
    ensurePlanMutationsAvailable(local, planning);
    undoEdit(local, owner, operationId, Date.now(), planning);
  });
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
function preferenceSummary(category) {
  if (category.id === 'appearance') {
    const value = document.documentElement.dataset.theme || 'dark';
    return `${value[0].toUpperCase()}${value.slice(1)} · ${category.scope}`;
  }
  if (category.id === 'process') return `${currentClarificationActions().length} actions · ${category.scope}`;
  return category.scope;
}
function refreshPreferenceRows() {
  for (const category of livePreferenceCategories) statusText(`preference-${category.id}-summary`, preferenceSummary(category));
}
function setupPreferenceRows() {
  $('preferencesCategories').replaceChildren(...livePreferenceCategories.map(category => {
    const item = document.createElement('li'), link = document.createElement('a'), label = document.createElement('span'), end = document.createElement('span'), summary = document.createElement('span'), arrow = document.createElement('span');
    link.id = `preference-${category.id}`; link.className = 'menu-row'; link.href = `#preferences/${category.id}`; link.dataset.preferenceId = category.id;
    label.textContent = category.label; end.className = 'menu-row-end'; summary.id = `${link.id}-summary`; summary.className = 'menu-row-value'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
    end.append(summary, arrow); link.append(label, end); item.append(link); return item;
  }));
  refreshPreferenceRows();
}
setupPreferenceRows();
document.addEventListener('clarification-actions-change', refreshPreferenceRows);
addEventListener('todo-appearance-change', refreshPreferenceRows);
function renderPreferences() {
  const category = preferenceCategory(destination), clarify = clarifyPreferenceRoute(destination), hub = destination === 'preferences';
  $('preferencesView').dataset.route = hub ? 'hub' : clarify ? `clarify-${clarify.view}` : 'detail';
  $('preferencesHubBar').hidden = !hub;
  for (const entry of livePreferenceCategories) {
    const active = category?.id === entry.id;
    $(entry.section).hidden = !active;
    const row = $(`preference-${entry.id}`);
    if (active) row.setAttribute('aria-current', 'page'); else row.removeAttribute('aria-current');
  }
  $('preferencesProcessPage').hidden = category?.id !== 'process' || !!clarify;
  $('clarifyActionsPage').hidden = !clarify;
  if (clarify) clarificationPreferences.render(destination);
  refreshPreferenceRows();
  if (category?.id === 'task-options' && !$('defaultsEditor').open) {
    const record = projected(state)['settings:settings'] || { type: 'settings', id: 'settings', version: 0 };
    openDefaults({ ...record, values: state.preferenceDraft?.defaults?.values }, false, false);
  }
}
function focusDestination() {
  if (!accountId || $('workspace').hidden) return;
  const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (modal) {
    if (!modal.contains(document.activeElement)) modal.querySelector('input, textarea, select, button')?.focus();
    return;
  }
  const preference = preferenceCategory(destination), clarify = clarifyPreferenceRoute(destination);
  if (destination === 'menu') $('menuHeading').focus({ preventScroll: true });
  else if (destination === 'preferences') $('preferencesHeading').focus({ preventScroll: true });
  else if (clarify) clarificationPreferences.focus();
  else if (preference) $(`${preference.section}Heading`).focus({ preventScroll: true });
  else (destination === 'capture' ? workspaceReadOnly() ? $('workspaceSelect') : capture.elements.text : destination === 'plan' ? $('planHeading') : destination === 'execute' ? $('executeHeading') : destination === 'reviews' ? $('reviewsHeading') : $('itemsHeading')).focus();
}
function restoreFocus(control) {
  const modal = [...document.querySelectorAll('dialog[open]')].at(-1), scope = modal || document;
  if (modal?.contains(document.activeElement) && document.activeElement !== control) return;
  // Labels and DOM nodes can change; record ID plus action remains stable.
  const matching = value => value ? scope.querySelector(`[data-focus-key="${CSS.escape(value)}"]`) : null;
  const primary = control?.isConnected && scope.contains(control) ? control : matching(control?.dataset.focusKey);
  const target = primary && !primary.disabled && primary.getClientRects().length ? primary : matching(control?.dataset.focusFallback);
  if (target && target !== document.body && !target.disabled && target.getClientRects().length) target.focus();
  else focusDestination();
}
function showDialog(dialog) {
  if (dialog.open) return;
  dialogOpeners.set(dialog, { control: document.activeElement, generation: accountGeneration });
  dialog.showModal();
}
function menuEntry() {
  const entry = history.state?.todoMenu;
  const returnable = workflowRoutes.includes(entry?.returnRoute) || isPreferenceRoute(entry?.returnRoute);
  return entry?.session === menuHistorySession && entry.accountId === accountId && entry.origin === location.origin && returnable && entry.target === 'appMenu' ? entry : null;
}
function workflowEntry(route = destination) {
  const entry = history.state?.todoWorkflow;
  return entry?.session === menuHistorySession && entry.accountId === accountId && entry.origin === location.origin && entry.route === route && entry.target === 'appMenu' && Number.isFinite(entry.scrollX) && Number.isFinite(entry.scrollY) ? entry : null;
}
function utilityReturnEntry(route = destination) {
  const entry = history.state?.todoUtilityReturn;
  const validTarget = route === 'menu'
    ? entry?.child === 'preferences' && entry.target === 'openPreferences'
    : route === 'preferences' && preferenceRoutes.has(entry?.child) && entry.target === `preference-${preferenceRoutes.get(entry.child).id}`;
  return entry?.session === menuHistorySession && entry.accountId === accountId && entry.origin === location.origin && entry.route === route && validTarget && Number.isFinite(entry.scrollX) && Number.isFinite(entry.scrollY) ? entry : null;
}
function preferenceEntry(route = destination) {
  const entry = history.state?.todoPreference;
  const descriptor = preferenceRouteParent(route);
  const validReturn = route === 'preferences'
    ? entry?.parent === 'menu' && entry.target === 'openPreferences'
    : descriptor && entry?.parent === descriptor.parent && entry.target === descriptor.target;
  return entry?.session === menuHistorySession && entry.accountId === accountId && entry.origin === location.origin && entry.route === route && validReturn && Number.isFinite(entry.scrollX) && Number.isFinite(entry.scrollY) ? entry : null;
}
function preferenceReturnEntry(route = destination) {
  const entry = history.state?.todoPreferenceReturn;
  const descriptor = preferenceRouteParent(entry?.child);
  const validTarget = descriptor?.parent === route && descriptor.target === entry?.target;
  return entry?.session === menuHistorySession && entry.accountId === accountId && entry.origin === location.origin && entry.route === route && validTarget && Number.isFinite(entry.scrollX) && Number.isFinite(entry.scrollY) ? entry : null;
}
function restoreRoutePosition(entry) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!accountId || destination !== entry.route || document.querySelector('dialog[open]')) return;
    scrollTo(entry.scrollX, entry.scrollY);
    $(entry.target)?.focus({ preventScroll: true });
  }));
}
async function enterMenu() {
  if (!accountId || destination === 'menu' || document.querySelector('dialog[open]')) {
    if (destination === 'menu') focusDestination();
    return;
  }
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const deleted = projected(state)['workspace:' + selectedWorkspace]?.deleted;
  if (!deleted) await journal();
  const marker = { session: menuHistorySession, accountId, origin: location.origin, route: destination, scrollX, scrollY, target: 'appMenu' };
  const current = history.state && typeof history.state === 'object' ? history.state : {};
  history.replaceState({ ...current, todoWorkflow: marker }, '', '#' + destination);
  history.pushState({ todoMenu: { session: menuHistorySession, accountId, origin: location.origin, returnRoute: destination, target: 'appMenu' } }, '', '#menu');
  workspace(true, { save: false });
}
function markUtilityReturn(child, target) {
  const current = history.state && typeof history.state === 'object' ? history.state : {};
  history.replaceState({ ...current, todoUtilityReturn: { session: menuHistorySession, accountId, origin: location.origin, route: destination, child, target, scrollX: window.scrollX, scrollY: window.scrollY } }, '', '#' + destination);
}
async function enterPreferences() {
  if (!accountId || destination !== 'menu' || !menuEntry() || document.querySelector('dialog[open]')) return;
  markUtilityReturn('preferences', 'openPreferences');
  history.pushState({ todoPreference: { session: menuHistorySession, accountId, origin: location.origin, route: 'preferences', parent: 'menu', target: 'openPreferences', scrollX: window.scrollX, scrollY: window.scrollY } }, '', '#preferences');
  workspace(true, { save: false });
}
async function enterPreferenceCategory(category) {
  if (!accountId || !category?.section || document.querySelector('dialog[open]')) return;
  const route = `preferences/${category.id}`;
  if (destination === route) { focusDestination(); return; }
  if (defaultsEditing?.type === 'settings') await journal();
  if (destination === 'preferences') {
    markUtilityReturn(route, `preference-${category.id}`);
    history.pushState({ todoPreference: { session: menuHistorySession, accountId, origin: location.origin, route, parent: 'preferences', target: `preference-${category.id}`, scrollX: window.scrollX, scrollY: window.scrollY } }, '', '#' + route);
  } else if (preferenceRoutes.has(destination)) {
    const current = history.state && typeof history.state === 'object' ? { ...history.state } : {};
    const returning = preferenceEntry();
    if (returning) current.todoPreference = { ...returning, route, target: `preference-${category.id}` };
    else delete current.todoPreference;
    history.replaceState(current, '', '#' + route);
  } else return;
  workspace(true, { save: false });
}
function markPreferenceReturn(child, target) {
  const current = history.state && typeof history.state === 'object' ? history.state : {};
  history.replaceState({ ...current, todoPreferenceReturn: { session: menuHistorySession, accountId, origin: location.origin, route: destination, child, target, scrollX: window.scrollX, scrollY: window.scrollY } }, '', '#' + destination);
}
function enterPreferenceRoute(route, { replace = false } = {}) {
  const descriptor = preferenceRouteParent(route);
  if (!accountId || !descriptor || !isPreferenceRoute(destination) || document.querySelector('dialog[open]')) return;
  const switchingEditor = clarifyPreferenceRoute(destination)?.view === 'editor' && clarifyPreferenceRoute(route)?.view === 'editor';
  if (replace || switchingEditor) {
    const current = history.state && typeof history.state === 'object' ? { ...history.state } : {};
    current.todoPreference = { session: menuHistorySession, accountId, origin: location.origin, route, parent: descriptor.parent, target: descriptor.target, scrollX: window.scrollX, scrollY: window.scrollY };
    history.replaceState(current, '', '#' + route);
  } else {
    markPreferenceReturn(route, descriptor.target);
    history.pushState({ todoPreference: { session: menuHistorySession, accountId, origin: location.origin, route, parent: descriptor.parent, target: descriptor.target, scrollX: window.scrollX, scrollY: window.scrollY } }, '', '#' + route);
  }
  workspace(true, { save: false });
}
async function leavePreferences() {
  if (destination === 'preferences/task-options') await journal();
  if (preferenceEntry()) history.back();
  else {
    const parent = clarifyPreferenceRoute(destination) ? preferenceRouteParent(destination)?.parent : null;
    history.replaceState(null, '', location.pathname + location.search + '#' + (parent || 'capture'));
    workspace(true, { save: false });
  }
}
function workspace(focus = true, { save = true, historyNavigation = false } = {}) {
  if (!accountId || !state || $('workspace').hidden) return;
  const requested = location.hash.slice(1) || 'capture';
  destination = [...workflowRoutes, 'menu', 'preferences'].includes(requested) || preferenceCategory(requested) ? requested : requested.startsWith(clarifyPreferenceRoot + '/') ? clarifyPreferenceRoot : 'capture';
  if (destination === 'menu' && !menuEntry()) {
    destination = 'capture';
    history.replaceState(null, '', location.pathname + location.search + '#capture');
  } else if (requested !== destination) history.replaceState(null, '', location.pathname + location.search + '#capture');
  const menu = destination === 'menu', preferences = isPreferenceRoute(destination), utility = menu || preferences;
  const listMode = destination === 'lists';
  document.body.classList.toggle('menu-route', menu);
  document.body.classList.toggle('utility-route', utility);
  $('menuView').hidden = !menu;
  $('preferencesView').hidden = !preferences;
  document.querySelector('.workspace-nav').hidden = utility;
  document.querySelector('.inbox-grid').hidden = utility;
  $('workspaceStatus').hidden = utility;
  if (menu) $('appMenu').setAttribute('aria-current', 'page'); else $('appMenu').removeAttribute('aria-current');
  document.querySelector('.capture-panel').hidden = destination !== 'capture';
  document.querySelector('.work-panel').hidden = !['work', 'lists'].includes(destination);
  $('plan').hidden = destination !== 'plan';
  $('reviews').hidden = destination !== 'reviews';
  $('execute').hidden = destination !== 'execute';
  $('listTools').hidden = !listMode;
  document.querySelector('.work-panel').classList.toggle('process-mode', !listMode);
  $('itemsHeading').textContent = listMode ? 'Organize' : 'Process';
  $('viewLabel').textContent = listMode ? 'Choose collection' : 'View';
  $('executionFilters').hidden = !listMode;
  for (const link of document.querySelectorAll('.workspace-nav a')) {
    if (link.hash === '#' + destination) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (preferences) renderPreferences();
  render();
  if (utility) $('savedEdit').hidden = true;
  if (focus) {
    $('createdDestination').replaceChildren();
    const returning = historyNavigation && (workflowEntry() || utilityReturnEntry() || preferenceReturnEntry());
    if (returning) restoreRoutePosition(returning);
    else {
      if (utility) focusDestination(); else requestAnimationFrame(focusDestination);
      if (save && !utility) void journal();
    }
  }
}
$('closeReviews').onclick = () => {
  history.replaceState(null, '', '#capture'); workspace(false); $('openReviews').focus(); void journal();
};
addEventListener('popstate', () => workspace(true, { save: false, historyNavigation: true }));
$('appMenu').addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault(); void enterMenu();
});
$('openPreferences').addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault(); void enterPreferences();
});
$('preferencesCategories').addEventListener('click', event => {
  const link = event.target.closest('[data-preference-id]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault(); void enterPreferenceCategory(livePreferenceCategories.find(category => category.id === link.dataset.preferenceId));
});
$('openClarifyActions').addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault(); enterPreferenceRoute(clarifyPreferenceRoot);
});
$('addClarifyAction').addEventListener('click', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault(); enterPreferenceRoute(`${clarifyPreferenceRoot}/add`);
});
document.addEventListener('clarification-preference-navigate', event => enterPreferenceRoute(event.detail.route, { replace: event.detail.replace }));
$('preferencesBack').onclick = () => { void leavePreferences(); };
for (const control of document.querySelectorAll('.preference-back')) control.onclick = () => { void leavePreferences(); };
$('clarifyActionsBack').onclick = () => { void leavePreferences(); };
$('clarifyActionEditorBack').onclick = () => { void leavePreferences(); };
matchMedia('(min-width: 1024px)').addEventListener('change', event => {
  if (!event.matches && clarifyPreferenceRoute(destination)?.view === 'editor' && !$('clarifyActionEditorPanel').contains(document.activeElement)) clarificationPreferences.focus();
});
$('menuBack').onclick = () => {
  if (menuEntry()) history.back();
  else { history.replaceState(null, '', location.pathname + location.search + '#capture'); workspace(true, { save: false }); }
};
for (const link of document.querySelectorAll('.workspace-nav a')) {
  link.addEventListener('click', event => {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && link.hash === location.hash) focusDestination();
  });
}
document.querySelector('.skip-link').onclick = event => {
  event.preventDefault();
  if (accountId) focusDestination(); else $('signIn').focus();
};
for (const dialog of [$('editor'), $('defaultsEditor'), $('appDevice'), $('dataRecovery'), $('clarifier'), $('briefs'), $('projectPlanner'), $('deletedRecords'), $('workspaceManager'), $('extractionReview'), $('recurringEditor'), $('archiveReview'), $('savedViewEditor')]) {
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
  const section = destination === 'lists' ? 'lists' : 'work';
  navigation[section] = {
    view: $('view').value, status: $('statusFilter').value,
    statuses: [...$('statusChoices').querySelectorAll('input:checked')].map(input => input.value),
    context: $('contextFilter').value, minutes: $('timeFilter').value, energy: $('energyFilter').value,
    ...(section === 'work' ? { search: currentSearch() } : {})
  };
  render(); void journal();
};
$('resetExecutionFilters').onclick = () => {
  Object.assign(navigation[destination === 'lists' ? 'lists' : 'work'], { context: '', minutes: '', energy: '' });
  render(); void journal();
};
$('searchForm').onsubmit = event => event.preventDefault();
$('searchForm').oninput = () => {
  navigation.work.search = { query: searchForm.elements.query.value, resultType: searchForm.elements.resultType.value, resultState: searchForm.elements.resultState.value };
  renderSearch(true, scopedRecords()); void journal();
};
$('resetSearch').onclick = () => { navigation.work.search = defaultSearch(); render(); void journal(); searchForm.elements.query.focus(); };
$('saveSearchView').onclick = guard(() => openSavedView());
$('closeSavedView').onclick = () => $('savedViewEditor').close();
$('savedViewEditor').addEventListener('close', () => { savedViewEditing = null; });
$('savedViewForm').onsubmit = event => {
  event.preventDefault();
  const record = savedViewEditing || { type: 'savedView', id: crypto.randomUUID(), version: 0 };
  const action = savedViewEditing ? 'update' : 'create', fields = savedViewFields();
  void saveSavedView(record, action, fields).then(() => {
    $('savedViewEditor').close(); $('savedViews').open = true;
    statusText('searchStatus', `${action === 'create' ? 'Saved' : 'Updated'} view “${fields.title}” on this device. Matching records were not changed.`);
  }).catch(failure => statusText('savedViewError', failure.message));
};
$('newList').onclick = () => openEditor(editing?.type === 'list' && editing.version === 0
  ? editing : { type: 'list', id: crypto.randomUUID(), version: 0, title: '', description: '', workspaceId: selectedWorkspace });
$('clarifyInbox').onclick = guard(() => clarification.openInbox());
function openDefaults(record, focus = true, show = true) {
  if (!state.defaultSettings) { error('Reconnect once to load the built-in options before editing defaults. Your work is kept.'); return; }
  if (defaultsEditing?.id !== record.id || defaultsEditing?.type !== record.type || defaultsEditing?.version !== record.version) {
    defaultsEditing = { type: record.type, id: record.id, version: record.version };
    const defaults = record.type === 'list' ? effectiveDefaults(record.id) : userDefaults();
    const values = record.values || Object.fromEntries(Object.keys(optionFields).map(name => [name, (defaults[name] || []).join('\n')]));
    fillValues($('defaultsForm'), values);
  }
  const accountDefaults = record.type === 'settings';
  const host = accountDefaults ? $('accountDefaultsHost') : $('listDefaultsHost');
  host.append($('defaultsSurface')); $('defaultsSurface').hidden = false;
  $('defaultsHeading').textContent = accountDefaults ? 'Options' : 'List defaults';
  $('resetDefaults').textContent = record.type === 'settings' ? 'Reset to built-in defaults' : 'Copy user defaults';
  $('closeDefaults').hidden = accountDefaults;
  $('defaultsError').hidden = true;
  if (show && !accountDefaults) showDialog($('defaultsEditor'));
  if (focus) {
    const control = $('defaultsForm').elements.contexts;
    control.focus(); control.setSelectionRange(0, 0); control.scrollTop = 0;
    void journal();
  }
}
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
        if (record.type === 'settings') local.preferenceDraft = { ...(local.preferenceDraft || {}), defaults: null };
        else currentDraft(local).defaults = null;
      });
      if (owner !== accountId) return;
      state = saved; defaultsEditing = null; clearError(); render();
      if (record.type === 'settings' && destination === 'preferences/task-options') openDefaults(projected(state)['settings:settings'] || { type: 'settings', id: 'settings', version: 0 }, false, false);
      else $('defaultsEditor').close();
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
  if (accountId && (location.hash === '#menu' || location.hash === '#preferences' || location.hash.startsWith('#preferences/'))) history.replaceState(null, '', location.pathname + location.search + '#capture');
  document.body.classList.remove('menu-route', 'utility-route'); $('menuView').hidden = true; $('preferencesView').hidden = true; $('appMenu').removeAttribute('aria-current');
  document.querySelectorAll('#preferencesCategories [aria-current]').forEach(link => link.removeAttribute('aria-current'));
  document.querySelectorAll('.workspace-nav [aria-current]').forEach(link => link.removeAttribute('aria-current'));
  $('appDevice').close(); $('dataRecovery').close();
  $('collectionOutline').replaceChildren(); $('collectionBreadcrumbs').textContent = ''; $('collectionChildren').replaceChildren(); $('readyToRevisitCollections').replaceChildren(); edit.elements.parentRef.replaceChildren(); editOrganizer.replaceChildren();
  $('archiveReview').close(); archiveReviewing = null; $('archiveSearch').value = ''; $('archiveResults').replaceChildren(); $('archiveStatus').textContent = '';
  $('savedViewEditor').close(); savedViewEditing = null; savedViewForm.reset(); $('savedViewEntries').replaceChildren(); $('searchResults').replaceChildren(); $('searchStatus').textContent = '';
  extraction.reset();
  $('deletedRecords').close(); $('deletedItems').replaceChildren(); $('deletedError').textContent = ''; $('deletedStatus').textContent = '';
  exportController?.abort();
  $('exportStatus').textContent = '';
  reviews.reset();
  briefs.reset(); projectPlanning.reset();
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
  $('menuSyncState').textContent = ''; $('menuWorkspaceValue').textContent = '';
  delete $('saveStatus').dataset.state; $('saveStatus').removeAttribute('title');
  $('accountName').textContent = 'Welcome'; $('workspaceSelect').hidden = true;
  $('signedOut').hidden = false; $('loginStatus').textContent = 'Sign in to continue.';
  document.title = 'Sign in';
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
  defaultsEditing = null; $('defaultsEditor').close(); $('listDefaultsHost').append($('defaultsSurface')); $('defaultsSurface').hidden = true; $('defaultsForm').reset();
  $('recurringEditor').close(); $('recurringTemplates').replaceChildren(); $('recurringStatus').textContent = '';
  $('editor').close(); $('editError').hidden = true; $('original').textContent = '';
  capture.reset(); edit.reset(); $('items').replaceChildren(); $('lists').replaceChildren();
  $('projectOutcome').textContent = ''; $('projectActions').replaceChildren(); $('day').value = $('planDay').value = '';
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
      if (identity.defaultSettings) local.defaultSettings = identity.defaultSettings;
    });
    if (generation !== accountGeneration) throw new Error('Account changed while opening its device copy. Reload to continue.');
    accountId = identity.accountId; state = saved; selectedWorkspace = saved.selectedWorkspace || PERSONAL;
    render(); $('workspace').hidden = false; restoreDraft(); requestAnimationFrame(focusDestination); broadcast();
  }
  $('workspace').hidden = false; $('signOut').hidden = false; $('signIn').hidden = true;
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
          continueCollectionMove(current, owner);
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
              if (pending) {
                pending.failure = failure.message;
                if (pending.workspaceMoveId && pending.workspaceMoveId === current.workspaceMove?.id) current.workspaceMove.failure = failure.message;
              }
            });
          }
          throw failure;
        }
        if (receipt.operationId !== entry.operation.operationId) throw new Error('Acknowledgement does not match this save.');
        await transact(owner, current => { applyReceipt(current, receipt, owner); continueCollectionMove(current, owner); });
      }
    });
    if (accountId === owner) {
      const saved = await transact(owner);
      if (accountId === owner) {
        state = saved; selectedWorkspace = saved.selectedWorkspace || PERSONAL; render(); $('workspace').hidden = false;
        continueSync ||= !!state.queue.length && !state.queue[0].failure;
        setTimeout(() => void materializeRecurrence(), 0);
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
$('resumeMove').onclick = guard(async () => {
  const owner = accountId;
  const saved = await transact(owner, local => resumeCollectionMove(local, owner));
  if (owner !== accountId) return;
  state = saved; render(); broadcast(); void sync();
});
$('recoverProjectPlan').onclick = guard(async () => {
  const owner = accountId, id = state.queue[0]?.operation.operationId;
  const saved = await transact(owner, local => {
    const entry = local.queue[0];
    if (entry?.operation.operationId !== id || !entry.failure || !entry.operation.mutations.some(mutation => mutation.type === 'projectPlanRevision')) throw new Error('Queue changed; review it again.');
    const revision = entry.operation.mutations.find(mutation => mutation.type === 'projectPlanRevision').fields;
    const project = local.records[`project:${revision.projectId}`];
    const recovered = recoverProjectPlanDraft(entry.operation, project, local.records);
    local.queue.shift();
    workspaceDraft(local, project.workspaceId).projectPlanning = { ...recovered, open: true };
    local.selectedWorkspace = project.workspaceId;
  });
  if (owner !== accountId) return;
  state = saved; selectedWorkspace = saved.selectedWorkspace || PERSONAL; render(); restoreDraft(); broadcast(); void sync();
});
$('resolve').onclick = guard(async () => {
  const owner = accountId, id = state.queue[0].operation.operationId;
  const reviewed = structuredClone(state.records);
  const reflectionMutations = await mergeReflectionConflict(state.queue[0], state.records);
  if (!confirm('Apply this pending edit to the latest server version shown?')) return;
  const saved = await transact(owner, local => {
    const entry = local.queue[0];
    if (entry?.operation.operationId !== id || !entry.receipt) throw new Error('Queue changed; review it again.');
    const planConflict = entry.operation.mutations.some(mutation => mutation.type === 'dailyPlan');
    const reflectionConflict = !!reflectionMutations;
    const mutations = planConflict || reflectionConflict ? [] : entry.operation.mutations.map(mutation => {
      const record = local.records[key(mutation)];
      if (mutation.action !== 'update' || !record || record.deleted) throw new Error('Deleted or missing records cannot be overwritten. Export your pending text to recover it separately.');
      if (record.version !== reviewed[key(mutation)]?.version) throw new Error('Server version changed again. Review the comparison before applying your edit.');
      return { ...mutation, expectedVersion: record.version };
    });
    if (planConflict) {
      const pendingRevisions = new Map(entry.operation.mutations.filter(mutation => mutation.type === 'dailyPlanRevision').map(mutation => [mutation.fields.planId, mutation]));
      for (const mutation of entry.operation.mutations) {
        if (mutation.type === 'dailyPlanRevision') continue;
        if (mutation.type !== 'dailyPlan') {
          const server = local.records[key(mutation)];
          if ((server?.version ?? 0) !== (reviewed[key(mutation)]?.version ?? 0)) throw new Error('A related action changed again. Review the comparison before applying your plan.');
          if (mutation.action === 'create' && !server) mutations.push(mutation);
          else if (server && !server.deleted) mutations.push({ ...mutation, action: 'update', expectedVersion: server.version });
          else throw new Error('A related action was deleted or changed incompatibly. Use the server plan for this save and reapply the membership deliberately.');
          continue;
        }
        const server = local.records[key(mutation)], originalRevision = pendingRevisions.get(mutation.id), revisionId = crypto.randomUUID();
        if (server && server.version !== reviewed[key(mutation)]?.version) throw new Error('Server plan changed again. Review the comparison before applying your plan.');
        const resetsAssessment = server && ['fits', 'full', 'overcommitted'].includes(server.loadAssessment) &&
          (JSON.stringify(server.actionIds) !== JSON.stringify(mutation.fields.actionIds) || entry.operation.mutations.some(candidate => candidate.type === 'item' && Object.hasOwn(candidate.fields || {}, 'effortEstimate') && (server.actionIds.includes(candidate.id) || mutation.fields.actionIds.includes(candidate.id))));
        const after = { actionIds: mutation.fields.actionIds, loadAssessment: resetsAssessment ? 'needs_reassessment' : mutation.fields.loadAssessment };
        const sequence = (server?.revisionCount || 0) + 1;
        mutations.push({ ...mutation, action: server ? 'update' : 'create', expectedVersion: server?.version || 0,
          fields: { ...mutation.fields, loadAssessment: after.loadAssessment, ...(server ? {} : { workspaceId: mutation.fields.workspaceId || originalRevision.fields.workspaceId, planDay: mutation.fields.planDay || originalRevision.fields.planDay }), revisionHead: revisionId, revisionCount: sequence } },
        { type: 'dailyPlanRevision', id: revisionId, action: 'create', expectedVersion: 0, fields: {
          ...originalRevision.fields, sequence, before: { actionIds: server?.actionIds || [], loadAssessment: server?.loadAssessment || 'needs_assessment' }, after
        } });
      }
    }
    if (reflectionConflict) {
      const pending = entry.operation.mutations.find(mutation => mutation.type === 'reviewReflection');
      const server = local.records[key(pending)];
      if (!server || server.deleted || server.version !== reviewed[key(pending)]?.version) throw new Error('The accepted reflection changed again. Review the comparison before merging.');
      for (const mutation of reflectionMutations) {
        if (local.records[key(mutation)]) throw new Error('The merged reflection or follow-up now exists. Sync and review the latest history before trying again.');
      }
      mutations.push(...reflectionMutations);
    }
    local.queue.shift();
    const later = local.queue; local.queue = [];
    enqueue(local, owner, mutations); local.queue.push(...later);
    if (reflectionConflict) {
      const reflection = reflectionMutations.find(mutation => mutation.type === 'reviewReflection');
      const savedDraft = currentDraft(local).review?.reflection;
      if (savedDraft?.rootReviewId === reflection.fields.reviewId) Object.assign(savedDraft, {
        baseReflectionId: reflection.id, prompts: structuredClone(reflection.fields.prompts), conclusion: reflection.fields.conclusion,
        followUp: entry.operation.mutations.some(mutation => mutation.type === 'item' && mutation.id === savedDraft.followUp?.id) ? null : savedDraft.followUp
      });
    }
  });
  if (owner !== accountId) return;
  state = saved;
  if (reflectionMutations) reviews.restore(currentDraft(state).review);
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
const resetDevice = $('resetDeviceData'), resetStatus = $('resetDeviceDataStatus');
resetDevice.onclick = async () => {
  if (resetDevice.getAttribute('aria-disabled') === 'true') return;
  resetDevice.setAttribute('aria-disabled', 'true');
  try {
    resetStatus.textContent = 'Checking cloud sign-in…';
    if (!accountId || !navigator.onLine) throw new Error('Sign in online before restoring your cloud copy.');
    if (!navigator.locks) throw new Error('This browser cannot coordinate a safe device reset between tabs.');
    const owner = accountId, identity = await request('session');
    if (identity.accountId !== owner) throw new Error('The signed-in account changed. Reload before clearing this device.');
    if (!confirm('Delete this browser’s To-Do database and reload from the cloud? Pending saves and unfinished drafts stored only on this device will be permanently lost. Export them first if needed.')) { resetStatus.textContent = ''; return; }
    resetStatus.textContent = 'Clearing the device database…';
    await navigator.locks.request(`todo-sync:${owner}`, async () => {
      if (owner !== accountId) throw new Error('The account changed. Reload before clearing this device.');
      await clearDeviceDatabase(() => { resetStatus.textContent = 'Close other To-Do tabs and app windows to finish clearing this device.'; });
    });
    location.reload();
  } catch (failure) {
    resetStatus.textContent = `Device database was not cleared: ${failure.message}`;
  } finally {
    resetDevice.removeAttribute('aria-disabled');
  }
};
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
  if (!document.hidden) { render(); void materializeRecurrence(); }
  if (!document.hidden && navigator.onLine) { $('workspace').hidden = true; void sync(); }
});
addEventListener('focus', () => { render(); void materializeRecurrence(); if (navigator.onLine) void sync(); });

try {
  await session({ allowOffline: true });
} catch (failure) { if (![401, 403].includes(failure.status)) error(failure.message); }
syncing = false;
connectionStatus();
if (accountId) { void materializeRecurrence(); void sync(); }
