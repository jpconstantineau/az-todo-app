export const optionFields = { contexts: 'Contexts', areas: 'Areas', energy: 'Energy', timeRequired: 'Time required', priority: 'Priority', statuses: 'Statuses' };
export const advancedFields = ['status', 'dueLocal', 'contexts', 'areas', 'energy', 'timeRequired', 'priority'];

export function formValues(form) {
  // Read disabled controls too: recovery must retain a form during a pending save.
  const values = Object.fromEntries([...form.elements].filter(control => control.name).map(control => [control.name, control.value]));
  for (const name of ['contexts', 'areas']) {
    if (form.elements.namedItem(name)?.multiple) values[name] = [...form.elements.namedItem(name).selectedOptions].map(option => option.value);
  }
  return values;
}
export function fillValues(form, values) {
  for (const [name, value] of Object.entries(values)) {
    const control = form.elements.namedItem(name);
    if (!control) continue;
    if (control.multiple) {
      for (const entry of value || []) if (![...control.options].some(option => option.value === entry)) control.add(new Option(entry, entry));
      for (const option of control.options) option.selected = (value || []).includes(option.value);
    } else {
      if (control.tagName === 'SELECT' && value && ![...control.options].some(option => option.value === value)) control.add(new Option(value, value));
      control.value = value ?? '';
    }
  }
}
export function localDate(utc) {
  if (!utc) return '';
  const date = new Date(utc);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function taskFields(values) {
  const date = values.dueLocal ? new Date(values.dueLocal) : null;
  if (date && (Number.isNaN(date.getTime()) || localDate(date.toISOString()) !== values.dueLocal)) throw new Error('Choose a valid local due date and time.');
  return { status: values.status || 'inbox', dueDateUtc: date?.toISOString() ?? null,
    contexts: values.contexts || [], areas: values.areas || [], energy: values.energy || null,
    timeRequired: values.timeRequired || null, priority: values.priority || null };
}
export function addTaskControls(container) {
  container.classList.add('form-grid');
  for (const [name, title] of [['dueLocal', 'Due (your local time)'], ['status', 'Status'], ...Object.entries(optionFields).filter(([name]) => name !== 'statuses')]) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement(name === 'dueLocal' ? 'input' : 'select'); input.name = name;
    if (name === 'dueLocal') input.type = 'datetime-local';
    if (['contexts', 'areas'].includes(name)) { input.multiple = true; input.size = 3; }
    label.append(input); container.append(label);
  }
}
export function refreshTaskOptions(form, defaults) {
  for (const name of advancedFields.filter(name => name !== 'dueLocal')) {
    const control = form.elements.namedItem(name);
    const selected = control.multiple ? [...control.selectedOptions].map(option => option.value) : [control.value];
    const values = name === 'status' ? ['inbox', 'next', 'deferred', 'completed', ...(defaults.statuses || [])] : defaults[name] || [];
    const options = [...new Set([...(control.multiple ? [] : name === 'status' ? [] : ['']), ...values, ...selected.filter(Boolean)])];
    control.replaceChildren(...options.map(value => new Option(value || 'None', value)));
    if (control.multiple) for (const option of control.options) option.selected = selected.includes(option.value);
    else control.value = selected[0] || (name === 'status' ? 'inbox' : '');
  }
}
export function defaultsFrom(form) {
  return Object.fromEntries(Object.keys(optionFields).map(name => {
    const values = form.elements.namedItem(name).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (values.length > 200 || values.some(value => value.length > 64 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error(`${name}: use at most 200 options, each a single line of at most 64 characters.`);
    return [name, [...new Set(values)]];
  }));
}
