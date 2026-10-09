const STORAGE_KEY = 'todo-clarification-actions';
const DRAFT_PREFIX = 'todo-clarification-action-draft:';
const VERSION = 1;
const DRAFT_VERSION = 1;
const MAX_ACTIONS = 32;

export const clarificationBehaviors = {
  'make-project': 'Make project',
  'make-list': 'Make list',
  'make-checklist': 'Make checklist',
  action: 'Action',
  reference: 'Reference',
  someday: 'Someday',
  'make-area': 'Make area',
  'make-role': 'Make role',
  'make-initiative': 'Make initiative',
  'make-program': 'Make program',
  'make-reference': 'Make reusable reference',
  trash: 'Move to Deleted'
};

const defaults = [
  ['project', 'Make project', 'make-project', 'primary'],
  ['list', 'Make list', 'make-list', 'primary'],
  ['checklist', 'Make checklist', 'make-checklist', 'primary'],
  ['action', 'Action', 'action', 'primary'],
  ['reference', 'Reference', 'reference', 'primary'],
  ['someday', 'Someday', 'someday', 'primary'],
  ['area', 'Make area', 'make-area', 'more'],
  ['role', 'Make role', 'make-role', 'more'],
  ['initiative', 'Make initiative', 'make-initiative', 'more'],
  ['program', 'Make program', 'make-program', 'more'],
  ['reference-list', 'Make reusable reference', 'make-reference', 'more'],
  ['trash', 'Move to Deleted', 'trash', 'more']
].map(([id, label, behavior, placement]) => ({ id, label, behavior, placement }));

export const clarificationActionDefaults = () => structuredClone(defaults);

export function validateClarificationActions(value) {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) throw new Error(`Choose at most ${MAX_ACTIONS} Clarify actions.`);
  const ids = new Set();
  return value.map(entry => {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object' || Object.keys(entry).some(key => !['id', 'label', 'behavior', 'placement'].includes(key))) throw new Error('Each Clarify action must have an ID, label, behavior and placement.');
    const id = typeof entry.id === 'string' ? entry.id : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || ids.has(id)) throw new Error('Each Clarify action needs a unique ID.');
    if (!label || label.length > 64 || /[\r\n]/.test(label)) throw new Error('Clarify action labels need 1–64 characters on one line.');
    if (!Object.hasOwn(clarificationBehaviors, entry.behavior)) throw new Error('Choose a supported Clarify behavior.');
    if (!['primary', 'more'].includes(entry.placement)) throw new Error('Choose Primary or More for each Clarify action.');
    ids.add(id);
    return { id, label, behavior: entry.behavior, placement: entry.placement };
  });
}

export function readClarificationActions(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const saved = JSON.parse(target.getItem(STORAGE_KEY));
    if (saved?.version !== VERSION) return clarificationActionDefaults();
    return validateClarificationActions(saved.actions);
  } catch { return clarificationActionDefaults(); }
}

export function writeClarificationActions(actions, storage) {
  const validated = validateClarificationActions(actions);
  const target = storage === undefined ? globalThis.localStorage : storage;
  target.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, actions: validated }));
  return validated;
}

export function insertClarificationAction(actions, action, position) {
  const without = actions.filter(entry => entry.id !== action.id);
  const positions = without.map((entry, index) => entry.placement === action.placement ? index : -1).filter(index => index >= 0);
  const offset = Math.max(0, Math.min(Number(position) - 1, positions.length));
  const index = offset < positions.length ? positions[offset] : positions.length ? positions.at(-1) + 1 : without.length;
  without.splice(index, 0, action);
  return validateClarificationActions(without);
}

export function readClarificationDraft(key, storage) {
  try {
    const target = storage === undefined ? globalThis.sessionStorage : storage;
    const saved = JSON.parse(target.getItem(DRAFT_PREFIX + key));
    if (saved?.version !== DRAFT_VERSION || !saved.values || typeof saved.values !== 'object') return null;
    return { ...saved.values };
  } catch { return null; }
}

export function writeClarificationDraft(key, values, storage) {
  const target = storage === undefined ? globalThis.sessionStorage : storage;
  target.setItem(DRAFT_PREFIX + key, JSON.stringify({ version: DRAFT_VERSION, values }));
}

export function clearClarificationDraft(key, storage) {
  const target = storage === undefined ? globalThis.sessionStorage : storage;
  target.removeItem(DRAFT_PREFIX + key);
}

let current = readClarificationActions();
export const currentClarificationActions = () => structuredClone(current);

const actionSnapshot = (actions, id) => {
  const action = actions.find(entry => entry.id === id);
  if (!action) return null;
  return { ...action, position: actions.filter(entry => entry.placement === action.placement).findIndex(entry => entry.id === id) + 1 };
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function setupClarificationPreferences() {
  const $ = id => document.getElementById(id);
  const groups = $('clarifyActionGroups'), form = $('clarifyActionEditor'), status = $('clarifyActionStatus');
  const editorStatus = $('clarifyActionEditorStatus'), error = $('clarifyActionError');
  if (!groups || !form || !status || !editorStatus || !error) return { render() {}, focus() {} };

  let route = 'preferences/process', activeEditorKey = null, baseline = null, conflict = false;
  const routeFor = id => `preferences/process/clarify-actions/edit/${id}`;
  const draftKey = id => id ? `edit:${id}` : 'add';
  const parsedRoute = value => {
    if (value === 'preferences/process/clarify-actions') return { view: 'list' };
    if (value === 'preferences/process/clarify-actions/add') return { view: 'editor', id: null };
    const match = value.match(/^preferences\/process\/clarify-actions\/edit\/([A-Za-z0-9_-]{1,128})$/);
    return match ? { view: 'editor', id: match[1] } : null;
  };
  const announce = (message, failed = false) => {
    status.textContent = failed ? '' : message;
    error.textContent = failed ? message : '';
    error.hidden = !failed;
  };
  const navigate = (next, replace = false, focus = true) => document.dispatchEvent(new CustomEvent('clarification-preference-navigate', { detail: { route: next, replace, focus } }));

  function persist(actions, message) {
    try {
      const validated = writeClarificationActions(actions);
      current = validated;
      announce(message);
      document.dispatchEvent(new CustomEvent('clarification-actions-change'));
      return true;
    } catch {
      announce('Clarify actions could not be stored. Nothing changed for reload or other tabs.', true);
      return false;
    }
  }

  function actionRow(entry, placement, position, length) {
    const row = document.createElement('li'); row.className = 'clarify-action-row'; row.dataset.actionId = entry.id;
    const link = document.createElement('a'); link.id = `clarify-action-${entry.id}`; link.className = 'clarify-action-link'; link.href = '#' + routeFor(entry.id); link.dataset.clarifyRoute = routeFor(entry.id); link.dataset.focusKey = `clarify:${entry.id}:edit`;
    if (parsedRoute(route)?.id === entry.id) link.setAttribute('aria-current', 'page');
    const label = document.createElement('span'); label.textContent = entry.label;
    link.append(label);
    if (entry.label !== clarificationBehaviors[entry.behavior]) {
      const behavior = document.createElement('span'); behavior.className = 'clarify-action-behavior'; behavior.textContent = clarificationBehaviors[entry.behavior]; link.append(behavior);
    }
    if (readClarificationDraft(draftKey(entry.id))) {
      const draft = document.createElement('span'); draft.className = 'clarify-action-draft'; draft.textContent = 'Draft'; link.append(draft);
    }
    const controls = document.createElement('div'); controls.className = 'clarify-action-order';
    for (const [direction, disabled] of [['up', position === 0], ['down', position === length - 1]]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.move = direction; button.disabled = disabled; button.textContent = direction === 'up' ? '↑' : '↓';
      button.setAttribute('aria-label', `Move ${entry.label} ${direction} in ${placement === 'primary' ? 'Primary' : 'More'}`);
      button.dataset.focusKey = `clarify:${entry.id}:${direction}`; controls.append(button);
    }
    row.append(link, controls); return row;
  }

  function renderMaster(focusKey = null) {
    for (const placement of ['primary', 'more']) {
      const list = $(`clarify${placement === 'primary' ? 'Primary' : 'More'}Actions`);
      const actions = current.filter(entry => entry.placement === placement);
      list.replaceChildren(...actions.map((entry, position) => actionRow(entry, placement, position, actions.length)));
    }
    $('clarifyActionCount').textContent = `${current.length} actions · Browser`;
    $('clarifyAddDraft').hidden = !readClarificationDraft('add');
    if (focusKey) {
      const restore = () => {
        const requested = groups.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
        const target = requested?.disabled ? requested.closest('[data-action-id]')?.querySelector('.clarify-action-link') : requested;
        target?.focus({ preventScroll: true });
      };
      restore(); queueMicrotask(restore); requestAnimationFrame(() => requestAnimationFrame(restore));
    }
  }

  function values() {
    return { label: form.elements.label.value, behavior: form.elements.behavior.value, placement: form.elements.placement.value, position: Number(form.elements.position.value) };
  }

  function fillPositions(selected) {
    const placement = form.elements.placement.value;
    const editingId = parsedRoute(route)?.id;
    const count = current.filter(entry => entry.placement === placement && entry.id !== editingId).length + 1;
    const value = Math.max(1, Math.min(Number(selected) || count, count));
    form.elements.position.replaceChildren(...Array.from({ length: count }, (_, index) => new Option(String(index + 1), String(index + 1), false, index + 1 === value)));
  }

  function setEditorStatus(message = '') { editorStatus.textContent = message; }
  function clearDraft(key) {
    try { clearClarificationDraft(key); return true; }
    catch { setEditorStatus('This draft could not be cleared from this tab.'); return false; }
  }
  function saveDraft() {
    const parsed = parsedRoute(route); if (parsed?.view !== 'editor') return;
    try {
      writeClarificationDraft(draftKey(parsed.id), values());
      setEditorStatus('Draft saved for this tab.'); renderMaster();
    } catch { setEditorStatus('This unfinished edit cannot survive reload in this tab.'); }
  }

  function loadEditor(parsed, focus = false) {
    const key = draftKey(parsed.id), latest = parsed.id ? actionSnapshot(current, parsed.id) : null;
    if (parsed.id && !latest) { activeEditorKey = null; navigate('preferences/process/clarify-actions', true); return; }
    const editorKey = parsed.id || 'add';
    if (activeEditorKey !== editorKey) {
      const editorDefaults = latest || { label: '', behavior: 'make-project', placement: 'primary', position: current.filter(entry => entry.placement === 'primary').length + 1 };
      const draft = readClarificationDraft(key), saved = { ...editorDefaults, ...(draft || {}) };
      form.elements.label.value = saved.label;
      form.elements.behavior.value = saved.behavior;
      form.elements.placement.value = saved.placement;
      fillPositions(saved.position);
      baseline = latest;
      conflict = false;
      activeEditorKey = editorKey;
      setEditorStatus(draft ? 'Draft restored for this tab.' : '');
    }
    $('clarifyActionEditorHeading').textContent = parsed.id ? 'Edit Clarify action' : 'Add Clarify action';
    $('removeClarifyAction').hidden = !parsed.id;
    $('clarifyRemoveHelp').hidden = !parsed.id;
    if (parsed.id) $('clarifyRemoveHelp').textContent = `Remove ${latest.label} from Clarify in this browser. This does not delete or change tasks${defaults.some(entry => entry.id === parsed.id) ? '; Restore defaults can add the built-in action again.' : '; Restore defaults will not recreate this custom action.'}`;
    if (conflict) announce('This action changed in another tab. Review or discard this draft before saving.', true);
    if (focus) requestAnimationFrame(() => $('clarifyActionEditorHeading').focus({ preventScroll: true }));
  }

  function render(nextRoute, { focus = false } = {}) {
    route = nextRoute;
    const parsed = parsedRoute(route);
    renderMaster();
    $('clarifyActionsHeading').hidden = parsed?.view === 'editor';
    $('clarifyActionsMasterHeading').hidden = parsed?.view !== 'editor';
    $('clarifyActionEditorPanel').hidden = parsed?.view !== 'editor';
    if (parsed?.view === 'editor') loadEditor(parsed, focus);
  }

  groups.addEventListener('click', event => {
    const routeLink = event.target.closest('[data-clarify-route]');
    if (routeLink && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault(); navigate(routeLink.dataset.clarifyRoute); return;
    }
    const button = event.target.closest('[data-move]'), row = button?.closest('[data-action-id]');
    if (!button || !row) return;
    const actions = currentClarificationActions(), index = actions.findIndex(entry => entry.id === row.dataset.actionId), placement = actions[index]?.placement;
    const peers = actions.map((entry, peerIndex) => entry.placement === placement ? peerIndex : -1).filter(peerIndex => peerIndex >= 0);
    const peer = peers.indexOf(index), other = peers[peer + (button.dataset.move === 'up' ? -1 : 1)];
    if (other === undefined) return;
    [actions[index], actions[other]] = [actions[other], actions[index]];
    if (persist(actions, 'Clarify action order saved for this browser.')) {
      const parsed = parsedRoute(route);
      if (parsed?.id) {
        if (readClarificationDraft(draftKey(parsed.id))) baseline = actionSnapshot(current, parsed.id);
        else { activeEditorKey = null; loadEditor(parsed); }
      }
      renderMaster(`clarify:${row.dataset.actionId}:${button.dataset.move}`);
    }
  });

  form.elements.placement.addEventListener('change', () => { fillPositions(); saveDraft(); });
  form.addEventListener('input', event => { if (event.target !== form.elements.placement) saveDraft(); });
  form.addEventListener('change', event => { if (event.target !== form.elements.placement) saveDraft(); });
  form.addEventListener('submit', event => {
    event.preventDefault(); announce('');
    const parsed = parsedRoute(route); if (parsed?.view !== 'editor') return;
    const latest = parsed.id ? actionSnapshot(current, parsed.id) : null;
    if (parsed.id && !same(latest, baseline)) {
      conflict = true; announce('This action changed or was removed in another tab. Review the latest settings or discard this draft.', true); $('discardClarifyActionDraft').focus(); return;
    }
    const id = parsed.id || crypto.randomUUID(), next = values();
    try {
      const actions = insertClarificationAction(currentClarificationActions(), { id, label: next.label, behavior: next.behavior, placement: next.placement }, next.position);
      if (!persist(actions, `${parsed.id ? 'Clarify action' : 'New Clarify action'} saved for this browser.`)) { form.elements.label.focus(); return; }
      clearDraft(draftKey(parsed.id)); activeEditorKey = null; renderMaster();
      navigate(routeFor(id), true, true);
    } catch (failure) {
      announce(failure.message, true);
      if (/label/i.test(failure.message)) form.elements.label.focus();
      else if (/behavior/i.test(failure.message)) form.elements.behavior.focus();
      else if (/Primary|More|placement/i.test(failure.message)) form.elements.placement.focus();
      else form.elements.label.focus();
    }
  });

  $('discardClarifyActionDraft').addEventListener('click', () => {
    const parsed = parsedRoute(route); if (parsed?.view !== 'editor') return;
    clearDraft(draftKey(parsed.id)); activeEditorKey = null; announce('Draft discarded. Saved settings are unchanged.'); loadEditor(parsed); form.elements.label.focus(); renderMaster();
  });
  $('removeClarifyAction').addEventListener('click', () => {
    const parsed = parsedRoute(route); if (!parsed?.id) return;
    const actions = currentClarificationActions(), index = actions.findIndex(entry => entry.id === parsed.id);
    if (index < 0 || !persist(actions.filter(entry => entry.id !== parsed.id), 'Clarify action removed from this browser.')) return;
    clearDraft(draftKey(parsed.id)); activeEditorKey = null;
    const next = current[Math.min(index, current.length - 1)];
    navigate(next ? routeFor(next.id) : 'preferences/process/clarify-actions', true, true);
  });
  $('resetClarifyActions').addEventListener('click', () => { $('restoreClarifyConfirmation').hidden = false; $('confirmResetClarifyActions').focus(); });
  $('cancelResetClarifyActions').addEventListener('click', () => { $('restoreClarifyConfirmation').hidden = true; $('resetClarifyActions').focus(); });
  $('confirmResetClarifyActions').addEventListener('click', () => {
    if (!persist(clarificationActionDefaults(), 'Restored 12 default Clarify actions for this browser.')) return;
    $('restoreClarifyConfirmation').hidden = true; activeEditorKey = null; renderMaster(); navigate(routeFor(current[0].id), false, true);
  });

  addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    current = readClarificationActions(); renderMaster();
    const parsed = parsedRoute(route);
    if (parsed?.view === 'editor') {
      const dirty = !!readClarificationDraft(draftKey(parsed.id));
      if (dirty && parsed.id && !same(actionSnapshot(current, parsed.id), baseline)) {
        conflict = true; announce('This action changed in another tab. Review or discard this draft before saving.', true);
      } else if (!dirty) { activeEditorKey = null; loadEditor(parsed); }
    }
    document.dispatchEvent(new CustomEvent('clarification-actions-change'));
  });
  form.elements.behavior.replaceChildren(...Object.entries(clarificationBehaviors).map(([value, text]) => new Option(text, value)));
  renderMaster();
  return {
    render,
    focus() {
      const parsed = parsedRoute(route);
      (parsed?.view === 'editor' ? $('clarifyActionEditorHeading') : $('clarifyActionsHeading')).focus({ preventScroll: true });
    },
    parsedRoute
  };
}
