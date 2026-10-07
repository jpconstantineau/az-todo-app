const STORAGE_KEY = 'todo-clarification-actions';
const VERSION = 1;
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

let current = readClarificationActions();
export const currentClarificationActions = () => structuredClone(current);

function save(actions, status) {
  current = validateClarificationActions(actions);
  try { writeClarificationActions(current); status.textContent = 'Clarify actions saved for this browser.'; }
  catch { status.textContent = 'Clarify actions are updated for this tab, but this browser could not store them.'; }
  document.dispatchEvent(new CustomEvent('clarification-actions-change'));
}

export function setupClarificationPreferences() {
  const list = document.getElementById('clarifyActionPreferences');
  const add = document.getElementById('addClarifyAction');
  const reset = document.getElementById('resetClarifyActions');
  const status = document.getElementById('clarifyActionStatus');
  if (!list || !add || !reset || !status) return;

  function render(focus = null) {
    list.replaceChildren();
    current.forEach((entry, index) => {
      const row = document.createElement('li'); row.className = 'clarify-preference-row'; row.dataset.actionId = entry.id;
      const label = document.createElement('label'); label.textContent = 'Label';
      const input = document.createElement('input'); input.value = entry.label; input.maxLength = 64; input.dataset.field = 'label'; input.setAttribute('aria-label', `Label for ${entry.label}`); label.append(input);
      const behaviorLabel = document.createElement('label'); behaviorLabel.textContent = 'Behavior';
      const behavior = document.createElement('select'); behavior.dataset.field = 'behavior';
      behavior.setAttribute('aria-label', `Behavior for ${entry.label}`); behavior.replaceChildren(...Object.entries(clarificationBehaviors).map(([value, text]) => new Option(text, value, false, value === entry.behavior))); behaviorLabel.append(behavior);
      const placementLabel = document.createElement('label'); placementLabel.textContent = 'Section';
      const placement = document.createElement('select'); placement.dataset.field = 'placement';
      placement.setAttribute('aria-label', `Section for ${entry.label}`); placement.append(new Option('Primary', 'primary', false, entry.placement === 'primary'), new Option('More', 'more', false, entry.placement === 'more')); placementLabel.append(placement);
      const controls = document.createElement('div'); controls.className = 'actions clarify-preference-controls';
      for (const [action, text, disabled] of [['up', 'Move up', index === 0], ['down', 'Move down', index === current.length - 1], ['remove', 'Remove', false]]) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action; button.textContent = text; button.disabled = disabled;
        button.setAttribute('aria-label', `${text} ${entry.label}`); controls.append(button);
      }
      row.append(label, behaviorLabel, placementLabel, controls); list.append(row);
    });
    if (focus) list.querySelector(`[data-action-id="${CSS.escape(focus.id)}"] [data-action="${focus.action}"]`)?.focus();
  }

  list.addEventListener('change', event => {
    const row = event.target.closest('[data-action-id]');
    if (!row || !event.target.dataset.field) return;
    const actions = currentClarificationActions(), entry = actions.find(candidate => candidate.id === row.dataset.actionId);
    entry[event.target.dataset.field] = event.target.value;
    try { save(actions, status); render(); }
    catch (error) { status.textContent = error.message; render(); }
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'), row = button?.closest('[data-action-id]');
    if (!button || !row) return;
    const actions = currentClarificationActions(), index = actions.findIndex(entry => entry.id === row.dataset.actionId);
    if (button.dataset.action === 'remove') {
      actions.splice(index, 1); save(actions, status); render();
      (list.children[Math.min(index, list.children.length - 1)]?.querySelector('input') || add.elements.label).focus(); return;
    }
    const other = button.dataset.action === 'up' ? index - 1 : index + 1;
    if (other < 0 || other >= actions.length) return;
    [actions[index], actions[other]] = [actions[other], actions[index]];
    save(actions, status); render({ id: row.dataset.actionId, action: button.dataset.action });
  });
  add.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(add), actions = currentClarificationActions();
    actions.push({ id: crypto.randomUUID(), label: data.get('label'), behavior: data.get('behavior'), placement: data.get('placement') });
    try { save(actions, status); const id = actions.at(-1).id; add.reset(); render(); list.querySelector(`[data-action-id="${CSS.escape(id)}"] input`)?.focus(); }
    catch (error) { status.textContent = error.message; add.elements.label.focus(); }
  });
  reset.addEventListener('click', () => { save(clarificationActionDefaults(), status); render(); list.querySelector('input')?.focus(); });
  add.elements.behavior.replaceChildren(...Object.entries(clarificationBehaviors).map(([value, text]) => new Option(text, value)));
  render();
  addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    current = readClarificationActions(); render(); document.dispatchEvent(new CustomEvent('clarification-actions-change'));
  });
}
