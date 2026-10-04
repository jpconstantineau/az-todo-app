import { belongsTo } from './collection-model.js?v=58';
export const briefSections = [
  ['outcome', 'Desired outcome'], ['context', 'Context and supplied sources'], ['scope', 'Scope'],
  ['exclusions', 'Exclusions'], ['nextAction', 'Proposed next action'],
  ['acceptanceChecks', 'Acceptance checks'], ['missingInformation', 'Missing information (or explicitly None known)']
];

export function templateBrief(subject, clarification, records = {}) {
  const accepted = name => clarification?.answers?.[name]?.decision === 'accepted' ? clarification.answers[name].value : '';
  const outcome = subject.outcome || accepted('outcome');
  const missing = [!outcome && 'Desired outcome is not yet specified.', 'Confirm scope, exclusions and acceptance checks.',
    subject.type === 'project' && 'Choose a concrete next action.', accepted('missingFacts') && `Clarification: ${accepted('missingFacts')}`].filter(Boolean);
  return {
    outcome: outcome || 'Unknown — describe what done looks like.',
    context: [subject.title, subject.description, subject.sourceTitle, subject.sourceUrl, ...(subject.referenceLinks || [])].filter(Boolean).join('\n'),
    scope: 'Unknown — specify what is included.', exclusions: 'Unknown — specify what is excluded, or explicitly None known.',
    nextAction: subject.type === 'item' ? subject.title : Object.values(records).filter(item => item.type === 'item' && !item.deleted && item.status === 'next' && belongsTo(item, subject)).map(item => item.title).join('\n') || 'Unknown — choose a concrete next action.',
    acceptanceChecks: 'Unknown — specify how the outcome will be checked.', missingInformation: missing.join('\n')
  };
}

export function readableBrief(record) {
  const status = record.status === 'accepted' && !record.localState ? 'ACCEPTED REVISION' :
    record.localState ? `UNCONFIRMED REVISION — ${record.status}; ${record.localState}` : `${record.status.toUpperCase()} — NOT ACCEPTED`;
  return [`Brief — ${status}`, `Revision ID: ${record.id}`, `Record version: ${record.version}`,
    `Source: ${record.subjectType}:${record.subjectId} at version ${record.sourceVersion}`,
    `Previous revision: ${record.previousBriefId || 'none'}`, ...briefSections.map(([key, label]) => `\n${label}\n${record.content[key]}`)].join('\n') + '\n';
}

export function setupBriefs({ records, save, journal, showDialog }) {
  const $ = id => document.getElementById(id), dialog = $('briefs'), form = $('briefForm');
  let active = null, busy = false;
  for (const [name, title] of briefSections) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('textarea'); input.name = name; input.rows = 3; input.maxLength = 4000; input.required = true;
    label.append(input); $('briefFields').append(label);
  }
  const content = () => Object.fromEntries(briefSections.map(([name]) => [name, form.elements[name].value]));
  const selected = () => active?.selectedId ? records()[`brief:${active.selectedId}`] : null;
  const dirty = () => briefSections.some(([name]) => form.elements[name].value !== active?.baseline?.[name]);
  const snapshot = () => active ? { ...structuredClone(active), content: content(), open: dialog.open } : null;
  function error(message) { $('briefError').textContent = message; }
  function draw() {
    const all = records(), subject = all[`${active.subjectType}:${active.subjectId}`];
    $('briefHeading').textContent = `Brief: ${subject?.title || 'Unavailable source'}`;
    $('briefOriginal').textContent = subject ? [subject.originalText, subject.sourceTitle, subject.sourceUrl, subject.selectedText, ...(subject.referenceLinks || [])].filter(Boolean).join('\n\n') : 'Source unavailable';
    const revisions = Object.values(all).filter(r => r.type === 'brief' && r.subjectType === active.subjectType && r.subjectId === active.subjectId && !r.deleted);
    $('briefRevisions').replaceChildren(new Option('New template draft', ''), ...revisions.map(r => new Option(`${r.status} · ${r.id}${r.localState ? ' · pending / needs attention' : ''}`, r.id)));
    $('briefRevisions').value = active.selectedId || '';
    for (const [name] of briefSections) form.elements[name].value = active.content[name];
    refresh();
  }
  function refresh() {
    const record = selected(), changed = dirty();
    const stateText = changed ? 'Edited draft — save a new revision before accepting.' : record ?
      `${record.status} · revision ${record.id} · ${record.localState || 'Server-confirmed'}` : 'Unaccepted template draft — review and save a revision.';
    if ($('briefState').textContent !== stateText) $('briefState').textContent = stateText;
    $('briefAccept').disabled = $('briefReject').disabled = busy || !record || changed || record.status !== 'draft';
    $('briefExport').disabled = busy || !record || changed;
  }
  function select(id) {
    const all = records(), subject = all[`${active.subjectType}:${active.subjectId}`], record = all[`brief:${id}`];
    if (!subject || subject.deleted) throw new Error('Source unavailable. Your existing brief revisions remain in the device export.');
    active = { subjectType: subject.type, subjectId: subject.id, sourceVersion: record?.sourceVersion || subject.version,
      selectedId: record?.id || null, content: record?.content || templateBrief(subject, all[`clarification:${subject.id}`], all) };
    active.baseline = structuredClone(active.content); draw(); error('');
  }
  async function commit(status) {
    if (busy || !active) return;
    if (!form.reportValidity()) return;
    const current = active, record = selected(), values = content(), focused = document.activeElement;
    let focusTarget = focused;
    busy = true;
    for (const control of dialog.querySelectorAll('button, select, textarea')) control.disabled = true;
    try {
      let mutation;
      if (status) {
        if (!record || dirty() || record.status !== 'draft') throw new Error('Save a draft revision, then accept or reject that exact content.');
        mutation = { type: 'brief', id: record.id, action: 'update', expectedVersion: record.version, fields: { status } };
      } else {
        if (record && !dirty()) throw new Error('Edit the content before saving a new revision.');
        mutation = { type: 'brief', id: crypto.randomUUID(), action: 'create', expectedVersion: 0, fields: {
          subjectType: current.subjectType, subjectId: current.subjectId, sourceVersion: current.sourceVersion,
          previousBriefId: record?.id || null, content: values, status: 'draft' } };
      }
      const next = { ...current, selectedId: mutation.id, content: values, baseline: structuredClone(values), open: true };
      await save(mutation, next);
      if (active !== current) return;
      active = next; draw(); error(''); focusTarget = $('briefState');
    } catch (failure) { if (active === current) error(failure.message); }
    finally {
      busy = false;
      for (const control of dialog.querySelectorAll('button, select, textarea')) control.disabled = false;
      if (active) refresh();
      if (dialog.open && active && (document.activeElement === document.body || document.activeElement === focused)) focusTarget.focus();
    }
  }
  form.addEventListener('input', () => { refresh(); void journal(); });
  form.addEventListener('submit', event => { event.preventDefault(); void commit(); });
  $('briefAccept').onclick = () => { void commit('accepted'); };
  $('briefReject').onclick = () => { void commit('rejected'); };
  $('briefRevisions').onchange = () => {
    if (dirty()) { $('briefRevisions').value = active.selectedId || ''; error('Save this edited draft as a new revision before selecting another.'); return; }
    try { select($('briefRevisions').value); void journal(); } catch (failure) { error(failure.message); }
  };
  $('briefExport').onclick = () => {
    if (dirty() || !selected()) return;
    const record = selected(), link = document.createElement('a'), url = URL.createObjectURL(new Blob([readableBrief(record)], { type: 'text/plain;charset=utf-8' }));
    link.href = url; link.download = `brief-${record.id}-${record.localState ? 'unconfirmed' : record.status}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('closeBriefs').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (active) void journal(); });
  return {
    snapshot,
    open(subject) {
      if (active && dirty()) {
        if (active.subjectId !== subject.id || active.subjectType !== subject.type) error('Save this edited draft before opening another brief.');
        showDialog(dialog); return;
      }
      active = { subjectType: subject.type, subjectId: subject.id };
      const revisions = Object.values(records()).filter(r => r.type === 'brief' && r.subjectType === subject.type && r.subjectId === subject.id && !r.deleted);
      select(revisions.at(-1)?.id || ''); showDialog(dialog); $('briefHeading').focus(); void journal();
    },
    restore(saved) { if (saved) { active = saved; draw(); if (saved.open) { showDialog(dialog); $('briefHeading').focus(); } } },
    render() { if (active) refresh(); },
    close() { dialog.close(); },
    reset() { active = null; dialog.close(); form.reset(); $('briefRevisions').replaceChildren(); for (const id of ['briefHeading', 'briefOriginal', 'briefState', 'briefError']) $(id).textContent = ''; }
  };
}
