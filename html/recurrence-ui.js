import { materializeMutations, nextAfterResolution, recurrenceDate, recurrenceRule, recurrenceZone } from './recurrence-model.js?v=1';

const fields = ['title', 'description', 'mode', 'interval', 'unit', 'anchorDate', 'timeZone', 'destination', 'status', 'contexts', 'areas', 'energy', 'timeRequired', 'priority', 'referenceLinks'];
const split = value => [...new Set(value.split(/[,\n]/).map(entry => entry.trim()).filter(Boolean))];
const referenceLinks = value => [...new Set(value.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean))].map(entry => {
  try {
    const url = new URL(entry);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || entry.length > 2048) throw new Error();
  } catch { throw new Error('Reference links must be HTTP(S) URLs without credentials.'); }
  return entry;
});
const destinationFields = value => {
  const [type, id] = value ? value.split(':') : [];
  return { collectionRefs: id ? [{ type, id }] : [], listId: type === 'list' ? id : null, projectId: type === 'project' ? id : null };
};

export function setupRecurrence({ records, workspaceId, readOnly, save, showDialog, restoreFocus, journal, label }) {
  const $ = id => document.getElementById(id), dialog = $('recurringEditor'), form = $('recurringForm');
  let editing = null;
  const templates = () => Object.values(records()).filter(record => record.type === 'recurrenceTemplate');
  const history = template => Object.values(records()).filter(record => record.type === 'item' && record.recurrenceTemplateId === template.id && record.occurrenceState !== 'open').sort((a, b) => b.recurrenceNumber - a.recurrenceNumber);
  const values = () => Object.fromEntries(fields.map(name => [name, form.elements.namedItem(name)?.value ?? '']));
  const snapshot = () => editing || dialog.open ? { editing: editing && { id: editing.id, version: editing.version }, values: values(), open: dialog.open } : null;
  function destinations(selected = '') {
    const choices = Object.values(records()).filter(record => ['list', 'project'].includes(record.type) && !record.deleted && record.workspaceId === workspaceId());
    form.elements.destination.replaceChildren(new Option('No collection', ''), ...choices.map(record => new Option(label(record), `${record.type}:${record.id}`)));
    if (selected && ![...form.elements.destination.options].some(option => option.value === selected)) form.elements.destination.add(new Option('Unavailable destination', selected));
    form.elements.destination.value = selected;
  }
  function showHistory(template) {
    const entries = history(template);
    $('recurrenceHistory').replaceChildren(...entries.map(item => {
      const row = document.createElement('p'), time = document.createElement('time');
      time.dateTime = item.occurrenceResolvedUtc; time.textContent = item.occurrenceResolvedUtc ? new Date(item.occurrenceResolvedUtc).toLocaleString() : 'Unknown resolution time';
      row.append(`${item.intendedDate} · ${item.occurrenceState} · `, time); return row;
    }));
    if (!entries.length) $('recurrenceHistory').textContent = 'No completed or skipped occurrences yet.';
  }
  function open(template = null, destination = '') {
    editing = template;
    form.reset(); destinations(destination || template?.collectionRefs?.[0] && `${template.collectionRefs[0].type}:${template.collectionRefs[0].id}` || '');
    const defaults = template ? { ...template, mode: template.rule.mode, interval: template.rule.interval, unit: template.rule.unit, anchorDate: template.rule.anchorDate, timeZone: template.rule.timeZone,
      contexts: (template.contexts || []).join(', '), areas: (template.areas || []).join(', '), referenceLinks: (template.referenceLinks || []).join('\n') }
      : { interval: '1', mode: 'fixed', unit: 'day', anchorDate: new Date().toISOString().slice(0, 10), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, status: 'inbox' };
    for (const [name, value] of Object.entries(defaults)) { const control = form.elements.namedItem(name); if (control) control.value = value ?? ''; }
    if (defaults.mode) form.elements.mode.value = defaults.mode;
    $('recurringEditorHeading').textContent = template ? `Recurring template: ${template.title}` : 'New recurring template';
    $('pauseRecurring').hidden = !template || !!template.tombstoned; $('deleteRecurring').hidden = !template;
    $('pauseRecurring').textContent = template?.paused ? 'Resume template' : 'Pause template';
    $('deleteRecurring').disabled = !!template?.tombstoned;
    $('deleteRecurring').textContent = template?.tombstoned ? 'Template stopped' : 'Delete template';
    form.querySelector('[type=submit]').disabled = !!template?.tombstoned;
    $('recurringError').textContent = ''; $('recurringSaveStatus').textContent = '';
    showHistory(template || { id: '' }); showDialog(dialog); $('recurringEditorHeading').focus(); void journal();
  }
  async function submit(event) {
    event.preventDefault(); if (readOnly()) return;
    try {
      const input = values(), rule = recurrenceRule({ mode: input.mode, unit: input.unit, interval: Number(input.interval), anchorDate: recurrenceDate(input.anchorDate), timeZone: recurrenceZone(input.timeZone) });
      const managed = { title: input.title, description: input.description, workspaceId: workspaceId(), ...destinationFields(input.destination), status: input.status,
        contexts: split(input.contexts), areas: split(input.areas), energy: input.energy || null, timeRequired: input.timeRequired || null, priority: input.priority || null, referenceLinks: referenceLinks(input.referenceLinks) };
      if (managed.referenceLinks.length > 20) throw new Error('Reference links must contain at most 20 URLs.');
      const fields = editing ? { ...managed, rule, ...(!editing.openOccurrenceId && JSON.stringify(rule) !== JSON.stringify(editing.rule)
        ? { nextIntendedDate: editing.lastResolvedUtc ? nextAfterResolution(rule, editing.lastResolvedUtc) : rule.anchorDate } : {}) }
        : { ...managed, rule, paused: false, tombstoned: false, nextOccurrenceNumber: 1, nextIntendedDate: rule.anchorDate, openOccurrenceId: null, lastResolvedUtc: null };
      const mutation = { type: 'recurrenceTemplate', id: editing?.id || crypto.randomUUID(), action: editing ? 'update' : 'create', expectedVersion: editing?.version || 0, fields };
      await save([mutation], 'Recurring template saved on device.', true); editing = null; dialog.close();
    } catch (failure) { $('recurringError').textContent = failure.message; }
  }
  async function stateChange(kind) {
    if (!editing || readOnly()) return;
    if (kind === 'delete' && !confirm(`Delete recurring template “${editing.title}”? Its occurrence history and any current occurrence remain available, but it can never generate work again.`)) return;
    const fields = kind === 'delete' ? { tombstoned: true, paused: true } : { paused: !editing.paused };
    try { await save([{ type: 'recurrenceTemplate', id: editing.id, action: 'update', expectedVersion: editing.version, fields }], kind === 'delete' ? 'Template stopped; history retained.' : `Template ${editing.paused ? 'resumed' : 'paused'}.`, true); editing = null; dialog.close(); }
    catch (failure) { $('recurringError').textContent = failure.message; }
  }
  form.addEventListener('input', () => void journal()); form.addEventListener('submit', submit);
  $('pauseRecurring').onclick = () => void stateChange('pause'); $('deleteRecurring').onclick = () => void stateChange('delete'); $('closeRecurring').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { editing = null; void journal(); });
  $('newRecurring').onclick = () => open(null, $('view').value && ['list', 'project'].includes(records()[`list:${$('view').value}`]?.type) ? `list:${$('view').value}` : $('view').value.startsWith('project:') ? $('view').value : '');
  function refresh(listMode) {
    $('recurringSection').hidden = !listMode;
    if (!listMode) return;
    const rows = templates().filter(template => template.workspaceId === workspaceId()).sort((a, b) => a.title.localeCompare(b.title));
    $('recurringTemplates').replaceChildren(...rows.map(template => {
      const article = document.createElement('article'), heading = document.createElement('h4'), state = document.createElement('p'), control = document.createElement('button');
      article.className = 'recurring-template'; heading.textContent = template.title; state.className = 'muted';
      state.textContent = `${template.tombstoned ? 'Stopped' : template.paused ? 'Paused' : 'Active'} · ${template.rule.mode === 'fixed' ? 'Fixed calendar' : 'After completion/skip'} · every ${template.rule.interval} ${template.rule.unit}${template.rule.interval === 1 ? '' : 's'} · next ${template.nextIntendedDate}`;
      control.type = 'button'; control.textContent = 'Open template and history'; control.dataset.focusKey = `recurrenceTemplate:${template.id}:open`; control.onclick = () => open(template);
      article.append(heading, state, control); return article;
    }));
    $('newRecurring').disabled = readOnly();
    if (!rows.length) $('recurringTemplates').textContent = 'No recurring templates in this workspace.';
  }
  async function materialize() {
    if (readOnly()) return;
    for (const template of templates().filter(template => template.workspaceId === workspaceId())) {
      const mutations = materializeMutations(template);
      if (mutations.length) { await save(mutations, 'Recurring occurrence created on device.'); return true; }
    }
    return false;
  }
  function restore(saved) {
    if (!saved) { dialog.close(); return; }
    const template = saved.editing && records()[`recurrenceTemplate:${saved.editing.id}`];
    open(template || null); for (const [name, value] of Object.entries(saved.values || {})) { const control = form.elements.namedItem(name); if (control) control.value = value; }
    if (!saved.open) dialog.close();
  }
  return { open, refresh, materialize, snapshot, restore };
}
