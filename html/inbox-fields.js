import { refKey } from './collection-model.js?v=4';
export const optionFields = { contexts: 'Contexts', areas: 'Areas', energy: 'Energy', timeRequired: 'Time required', priority: 'Priority', statuses: 'Statuses' };
export const advancedFields = ['status', 'projectId', 'plannedDay', 'dueLocal', 'dueDate', 'startDate', 'reviewDate', 'startDateUtc', 'reviewDateUtc', 'waitingOn', 'contexts', 'areas', 'energy', 'timeRequired', 'priority', 'importance', 'urgency', 'referenceLinks'];
export const workflowFields = ['status', 'waitingOn', 'startDate', 'startDateUtc', 'reviewDate', 'reviewDateUtc'];

export const readyToExecute = record => ['inbox', 'next'].includes(record.status);

export function executionDurationMinutes(value) {
  const duration = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i.exec(typeof value === 'string' ? value.trim() : '');
  return duration ? Number(duration[1]) * (/^h/i.test(duration[2]) ? 60 : 1) : null;
}

const executionTitleCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const codePointCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
export function compareExecutionItems(left, right, matrix = false) {
  const priority = value => {
    const index = ['p1', 'p2', 'p3', 'p4', 'p5'].indexOf(typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, '') : '');
    return index < 0 ? 5 : index;
  };
  let compared = priority(effectivePriority(left, matrix)) - priority(effectivePriority(right, matrix));
  if (!compared && matrix) compared = (right.urgency ?? 0) - (left.urgency ?? 0);
  if (compared) return compared;

  const leftDuration = executionDurationMinutes(left.timeRequired), rightDuration = executionDurationMinutes(right.timeRequired);
  if (leftDuration === null || rightDuration === null) {
    if (leftDuration !== rightDuration) return leftDuration === null ? 1 : -1;
  } else if (leftDuration !== rightDuration) return rightDuration - leftDuration;

  const energy = value => {
    const index = ['high', 'medium', 'low'].indexOf(typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, '') : '');
    return index < 0 ? 3 : index;
  };
  compared = energy(left.energy) - energy(right.energy);
  if (compared) return compared;

  const leftTitle = typeof left.title === 'string' ? left.title : '', rightTitle = typeof right.title === 'string' ? right.title : '';
  const leftHasTitle = !!leftTitle, rightHasTitle = !!rightTitle;
  if (leftHasTitle !== rightHasTitle) return leftHasTitle ? -1 : 1;
  compared = executionTitleCollator.compare(leftTitle, rightTitle) || codePointCompare(leftTitle, rightTitle);
  return compared || codePointCompare(typeof left.id === 'string' ? left.id : '', typeof right.id === 'string' ? right.id : '');
}

export function matchesExecutionFilters(record, filters) {
  if (filters.context === '@none' && record.contexts?.length) return false;
  if (filters.context?.startsWith('context:') && !record.contexts?.includes(filters.context.slice(8))) return false;
  // Custom estimates that cannot be compared stay visible alongside unspecified values.
  const duration = executionDurationMinutes(record.timeRequired);
  if (filters.minutes && duration !== null && duration > Number(filters.minutes)) return false;
  const levels = ['low', 'medium', 'high'];
  const required = levels.indexOf(record.energy?.trim().toLowerCase());
  const available = levels.indexOf(filters.energy);
  return available < 0 || required <= available;
}

export function validateWorkflow(record, old, fields = record) {
  if (!old || workflowFields.some(key => key in fields && (fields[key] ?? null) !== (old[key] ?? null))) {
    if (record.status === 'waiting' && !record.waitingOn?.trim()) throw new Error('Waiting needs who/what you are waiting for.');
    if (record.status === 'deferred' && !(record.startDate || record.startDateUtc)) throw new Error('Deferred needs a start date; it becomes ready for review on that date.');
    const prefix = ['waiting', 'someday'].includes(record.status) ? 'review' : record.status === 'deferred' ? 'start' : null;
    if (prefix) taskFields({ [`${prefix}Date`]: record[`${prefix}Date`], [`${prefix}DateUtc`]: record[`${prefix}DateUtc`] });
  }
  for (const name of ['due', 'start', 'review']) {
    if ((!old || `${name}Date` in fields || `${name}DateUtc` in fields) && record[`${name}Date`] && record[`${name}DateUtc`]) throw new Error(`Choose a calendar ${name} date or a timed ${name} date, not both.`);
  }
}
export function reviewReady(record, now = new Date()) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const prefix = record.status === 'deferred' ? 'start' : ['waiting', 'someday'].includes(record.status) ? 'review' : null;
  return !!prefix && (!!record[`${prefix}Date`] && record[`${prefix}Date`] <= day || !!record[`${prefix}DateUtc`] && Date.parse(record[`${prefix}DateUtc`]) <= now.getTime());
}

export function formValues(form) {
  // Read disabled controls too: recovery must retain a form during a pending save.
  const values = Object.fromEntries([...form.elements].filter(control => control.name).map(control =>
    [control.name, control.type === 'radio' ? form.elements.namedItem(control.name).value : control.value]));
  for (const name of ['contexts', 'areas', 'collectionRefs']) {
    if (form.elements.namedItem(name)?.multiple) values[name] = [...form.elements.namedItem(name).selectedOptions].map(option => name === 'collectionRefs' ? { type: option.value.split(':')[0], id: option.value.split(':')[1] } : option.value);
  }
  if ('referenceLinks' in values) values.referenceLinks = values.referenceLinks.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  for (const name of ['importance', 'urgency']) if (name in values) values[name] = Number(values[name]);
  return values;
}
export function fillValues(form, values) {
  for (const [name, value] of Object.entries(values)) {
    const control = form.elements.namedItem(name);
    if (!control) continue;
    if (control.multiple) {
      const selected = name === 'collectionRefs' ? (value || []).map(refKey) : value || [];
      for (const entry of selected) if (![...control.options].some(option => option.value === entry)) control.add(new Option(entry, entry));
      for (const option of control.options) option.selected = selected.includes(option.value);
    } else {
      if (control.tagName === 'SELECT' && value && ![...control.options].some(option => option.value === value)) control.add(new Option(value, value));
      control.value = name === 'referenceLinks' && Array.isArray(value) ? value.join('\n') : value ?? '';
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
  if (values.referenceLinks !== undefined) {
    if (!Array.isArray(values.referenceLinks) || values.referenceLinks.length > 20) throw new Error('Reference links must contain at most 20 HTTP(S) URLs.');
    for (const value of values.referenceLinks) {
      try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || value.length > 2048) throw new Error();
      } catch { throw new Error('Reference links must be HTTP(S) URLs without credentials.'); }
    }
    result.referenceLinks = values.referenceLinks;
  }
  for (const name of ['importance', 'urgency']) if (name in values) {
    if (![-1, 0, 1].includes(values[name])) throw new Error(`${name} must be -1, 0 or 1.`);
    result[name] = values[name];
  }
  for (const name of unchanged) delete result[name];
  return result;
}
export function addTaskControls(container) {
  const common = document.createElement('div'); common.className = 'form-grid';
  const dates = document.createElement('details'), metadata = document.createElement('details');
  dates.className = 'task-dates'; metadata.className = 'task-metadata';
  for (const [section, title] of [[dates, 'Dates and waiting'], [metadata, 'Context, time & energy']]) {
    const summary = document.createElement('summary'); summary.textContent = title;
    section.append(summary);
  }
  container.append(common, dates, metadata);
  for (const [name, title] of [['projectId', 'Project (optional)'], ['plannedDay', 'Planned day (not a deadline)'], ['status', 'Status'], ['waitingOn', 'Waiting for (person or dependency)'], ['dueDate', 'Deadline (calendar date)'], ['dueLocal', 'Deadline time (local; repeated DST hour uses first occurrence)'], ['startDate', 'Deferred until (calendar date)'], ['startDateUtc', 'Or deferred until (ISO time with offset)'], ['reviewDate', 'Review on (optional calendar date)'], ['reviewDateUtc', 'Or review on (optional ISO time with offset)'], ...Object.entries(optionFields).filter(([name]) => name !== 'statuses'), ['referenceLinks', 'Reference links (one HTTP(S) URL per line)']]) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement(name === 'referenceLinks' ? 'textarea' : ['status', 'projectId'].includes(name) || name in optionFields ? 'select' : 'input'); input.name = name;
    if (name === 'dueLocal') input.type = 'datetime-local';
    else if (name.endsWith('Date') || name === 'plannedDay') { input.type = 'date'; input.min = '0001-01-01'; input.max = '9999-12-31'; }
    else if (name.endsWith('DateUtc')) input.placeholder = '2026-11-01T01:30:00-05:00';
    else if (name === 'waitingOn') input.maxLength = 4000;
    if (['contexts', 'areas'].includes(name)) { input.multiple = true; input.size = 3; }
    label.append(input);
    (['status', 'projectId'].includes(name) ? common : name in optionFields || name === 'referenceLinks' ? metadata : dates).append(label);
    if (name === 'status') input.addEventListener('change', () => {
      if (['waiting', 'deferred'].includes(input.value)) dates.open = true;
    });
  }
  addPriorityControls(metadata);
  const help = document.createElement('p'); help.className = 'muted';
  help.textContent = 'Choose a calendar date or a timed value for each purpose. Waiting needs a dependency; its review date is optional. Undated waiting work stays in Waiting and weekly reviews. Deferred work appears in Ready for review from its start date on your next refresh; choose Next when ready. Neither changes your deadline or planned day.';
  dates.append(help);
  // Native validation must reveal a collapsed field before focusing its error.
  container.addEventListener('invalid', event => {
    for (let parent = event.target.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
  }, true);
}
export function refreshTaskOptions(form, defaults) {
  for (const name of ['status', ...Object.keys(optionFields).filter(name => name !== 'statuses')]) {
    const control = form.elements.namedItem(name);
    if (!control) continue;
    const selected = control.multiple ? [...control.selectedOptions].map(option => option.value) : [control.value];
    const values = name === 'status' ? ['inbox', 'next', 'waiting', 'deferred', 'someday', 'reference', 'completed', 'dropped', ...(defaults.statuses || [])] : defaults[name] || [];
    const options = [...new Set([...(control.multiple ? [] : name === 'status' ? [] : ['']), ...values, ...selected.filter(Boolean)])];
    control.replaceChildren(...options.map(value => new Option(name === 'status' && value === 'reference' ? 'Reference (non-actionable)' : value || 'None', value)));
    if (control.multiple) for (const option of control.options) option.selected = selected.includes(option.value);
    else control.value = selected[0] || (name === 'status' ? 'inbox' : '');
  }
}
export function optionsFromText(name, value) {
  const values = [...new Set(value.split(/\r?\n/).map(option => option.trim()).filter(Boolean))];
  if (values.length > 200 || values.some(option => option.length > 64 || /[\u0000-\u001f\u007f]/.test(option))) {
    throw new Error(`${name}: use at most 200 unique options, each a single line of at most 64 characters.`);
  }
  return values;
}

export function defaultsFrom(form) {
  return Object.fromEntries(Object.keys(optionFields).map(name => [name, optionsFromText(name, form.elements.namedItem(name).value)]));
}

export const effectivePriority = (record, matrix = false) => matrix ? `P${3 - (record.importance ?? 0) - (record.urgency ?? 0)}` : record.priority;

export function priorityFields(values, matrix = false) {
  return matrix ? { importance: values.importance ?? 0, urgency: values.urgency ?? 0 } : { priority: values.priority || null };
}

export function addPriorityControls(container, values = {}, onChange = null, prefix = '') {
  const group = document.createElement('div'); group.className = 'matrix-priority';
  for (const [name, question, yes, no] of [['importance', 'How important is this compared with your other work?', 'Important', 'Not important'], ['urgency', 'How urgent is this compared with your other work?', 'Urgent', 'Not urgent']]) {
    const fieldset = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = question; fieldset.append(legend);
    for (const [score, title] of [[1, yes], [0, 'Unset'], [-1, no]]) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'radio'; input.name = prefix + name; input.value = String(score); input.defaultChecked = input.checked = score === (values[name] ?? 0);
      label.append(input, title); fieldset.append(label);
      input.addEventListener('change', () => { updatePriorityPreview(group); onChange?.(name, score); });
    }
    group.append(fieldset);
  }
  const output = document.createElement('output'), help = document.createElement('p'); output.setAttribute('aria-live', 'polite'); help.className = 'muted';
  help.textContent = 'Unset is the middle of each scale. Urgency breaks ties within a priority level.';
  group.append(output, help); container.append(group); updatePriorityPreview(group); return group;
}
export function updatePriorityPreview(group) {
  const axes = Object.fromEntries([...group.querySelectorAll('input:checked')].map(input => [input.name.endsWith('importance') ? 'importance' : 'urgency', Number(input.value)]));
  group.querySelector('output').textContent = `Priority ${effectivePriority(axes, true)}`;
}
export function refreshPriorityControls(form, matrix) {
  const manual = form.elements.namedItem('priority'), group = form.querySelector('.matrix-priority');
  if (!group) return;
  manual.closest('label').hidden = matrix;
  group.hidden = !matrix;
  updatePriorityPreview(group);
}
