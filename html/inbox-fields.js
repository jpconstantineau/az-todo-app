export const optionFields = { contexts: 'Contexts', areas: 'Areas', energy: 'Energy', timeRequired: 'Time required', priority: 'Priority', statuses: 'Statuses' };
export const advancedFields = ['status', 'projectId', 'plannedDay', 'dueLocal', 'dueDate', 'startDate', 'reviewDate', 'startDateUtc', 'reviewDateUtc', 'waitingOn', 'contexts', 'areas', 'energy', 'timeRequired', 'priority'];
export const workflowFields = ['status', 'waitingOn', 'startDate', 'startDateUtc', 'reviewDate', 'reviewDateUtc'];

export function matchesExecutionFilters(record, filters) {
  if (filters.context === '@none' && record.contexts?.length) return false;
  if (filters.context?.startsWith('context:') && !record.contexts?.includes(filters.context.slice(8))) return false;
  // Custom estimates that cannot be compared stay visible alongside unspecified values.
  const duration = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i.exec(record.timeRequired?.trim() || '');
  if (filters.minutes && duration && Number(duration[1]) * (/^h/i.test(duration[2]) ? 60 : 1) > Number(filters.minutes)) return false;
  const levels = ['low', 'medium', 'high'];
  const required = levels.indexOf(record.energy?.trim().toLowerCase());
  const available = levels.indexOf(filters.energy);
  return available < 0 || required <= available;
}

export function validateWorkflow(record, old, fields = record) {
  if (!old || workflowFields.some(key => key in fields && (fields[key] ?? null) !== (old[key] ?? null))) {
    if (record.status === 'waiting' && !record.waitingOn?.trim()) throw new Error('Waiting needs who/what you are waiting for.');
    if (record.status === 'deferred' && !(record.startDate || record.startDateUtc)) throw new Error('Deferred needs a start date; it becomes ready for review on that date.');
    const prefix = record.status === 'waiting' ? 'review' : record.status === 'deferred' ? 'start' : null;
    if (prefix) taskFields({ [`${prefix}Date`]: record[`${prefix}Date`], [`${prefix}DateUtc`]: record[`${prefix}DateUtc`] });
  }
  for (const name of ['due', 'start', 'review']) {
    if ((!old || `${name}Date` in fields || `${name}DateUtc` in fields) && record[`${name}Date`] && record[`${name}DateUtc`]) throw new Error(`Choose a calendar ${name} date or a timed ${name} date, not both.`);
  }
}
export function reviewReady(record, now = new Date()) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const prefix = record.status === 'deferred' ? 'start' : record.status === 'waiting' ? 'review' : null;
  return !!prefix && (!!record[`${prefix}Date`] && record[`${prefix}Date`] <= day || !!record[`${prefix}DateUtc`] && Date.parse(record[`${prefix}DateUtc`]) <= now.getTime());
}

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
  if (!Number.isFinite(date.getTime())) return ''; // Historic invalid values remain on the record.
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function taskFields(values, initial = null) {
  values = { ...values };
  const unchanged = [];
  for (const name of ['dueLocal', 'dueDate', 'startDate', 'reviewDate', 'startDateUtc', 'reviewDateUtc']) {
    if (initial && (values[name] || '') === (initial[name] || '')) {
      unchanged.push(name === 'dueLocal' ? 'dueDateUtc' : name);
      values[name] = '';
    }
  }
  const date = values.dueLocal ? new Date(values.dueLocal) : null;
  if (date && (Number.isNaN(date.getTime()) || localDate(date.toISOString()) !== values.dueLocal)) throw new Error('Choose a valid local due date and time.');
  const dates = {};
  for (const name of ['dueDate', 'startDate', 'reviewDate']) {
    const value = values[name];
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`${name}: choose a valid calendar date.`);
    dates[name] = value || null;
  }
  for (const name of ['startDateUtc', 'reviewDateUtc']) {
    const value = values[name];
    // Explicit offsets make repeated DST times unambiguous. Normalize only new edits.
    if (value && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) ||
        new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23)) throw new Error(`${name}: enter an ISO time with Z or an explicit offset, for example 2026-11-01T01:30:00-05:00.`);
    dates[name] = value ? new Date(value).toISOString() : null;
  }
  const result = { projectId: values.projectId || null, plannedDay: values.plannedDay || null, ...dates, waitingOn: values.waitingOn || '', status: values.status || 'inbox', dueDateUtc: date?.toISOString() ?? null,
    contexts: values.contexts || [], areas: values.areas || [], energy: values.energy || null,
    timeRequired: values.timeRequired || null, priority: values.priority || null };
  for (const name of unchanged) delete result[name];
  return result;
}
export function addTaskControls(container) {
  container.classList.add('form-grid');
  for (const [name, title] of [['projectId', 'Project (optional)'], ['plannedDay', 'Planned day (not a deadline)'], ['status', 'Status'], ['waitingOn', 'Waiting for (person or dependency)'], ['dueDate', 'Deadline (calendar date)'], ['dueLocal', 'Deadline time (local; repeated DST hour uses first occurrence)'], ['startDate', 'Deferred until (calendar date)'], ['startDateUtc', 'Or deferred until (ISO time with offset)'], ['reviewDate', 'Review on (optional calendar date)'], ['reviewDateUtc', 'Or review on (optional ISO time with offset)'], ...Object.entries(optionFields).filter(([name]) => name !== 'statuses')]) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement(['status', 'projectId'].includes(name) || name in optionFields ? 'select' : 'input'); input.name = name;
    if (name === 'dueLocal') input.type = 'datetime-local';
    else if (name.endsWith('Date') || name === 'plannedDay') { input.type = 'date'; input.min = '0001-01-01'; input.max = '9999-12-31'; }
    else if (name.endsWith('DateUtc')) input.placeholder = '2026-11-01T01:30:00-05:00';
    else if (name === 'waitingOn') input.maxLength = 4000;
    if (['contexts', 'areas'].includes(name)) { input.multiple = true; input.size = 3; }
    label.append(input); container.append(label);
  }
  const help = document.createElement('p'); help.className = 'muted';
  help.textContent = 'Choose a calendar date or a timed value for each purpose. Waiting needs a dependency; its review date is optional. Undated waiting work stays in Waiting and weekly reviews. Deferred work appears in Ready for review from its start date on your next refresh; choose Next when ready. Neither changes your deadline or planned day.';
  container.append(help);
}
export function refreshTaskOptions(form, defaults) {
  for (const name of ['status', ...Object.keys(optionFields).filter(name => name !== 'statuses')]) {
    const control = form.elements.namedItem(name);
    const selected = control.multiple ? [...control.selectedOptions].map(option => option.value) : [control.value];
    const values = name === 'status' ? ['inbox', 'next', 'waiting', 'deferred', 'reference', 'completed', 'dropped', ...(defaults.statuses || [])] : defaults[name] || [];
    const options = [...new Set([...(control.multiple ? [] : name === 'status' ? [] : ['']), ...values, ...selected.filter(Boolean)])];
    control.replaceChildren(...options.map(value => new Option(name === 'status' && value === 'reference' ? 'Reference (non-actionable)' : value || 'None', value)));
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
