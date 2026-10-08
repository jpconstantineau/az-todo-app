import { draftFromAccepted, projectPlanMutations, validateProjectPlanDraft } from './project-planning-model.js?v=1';

export function setupProjectPlanning({ records, journal, showDialog, save }) {
  const $ = id => document.getElementById(id), dialog = $('projectPlanner'), form = $('projectPlanningForm');
  let active = null, busy = false, dirty = false;
  const read = () => active ? { ...structuredClone(active), sections: {
    purposePrinciples: form.elements.purposePrinciples.value,
    desiredEvidence: form.elements.desiredEvidence.value,
    organizationApproach: form.elements.organizationApproach.value,
    unresolvedQuestions: form.elements.unresolvedQuestions.value
  }, candidates: [...$('projectPlanCandidates').querySelectorAll('[data-candidate-id]')].map(row => ({
    id: row.dataset.candidateId, title: row.querySelector('input').value, kind: row.querySelector('select').value,
    ...(row.dataset.itemId ? { itemId: row.dataset.itemId } : {})
  })) } : null;
  const status = text => { $('projectPlanningStatus').textContent = text; };
  function candidateRow(candidate) {
    const row = document.createElement('article'); row.className = 'project-plan-candidate'; row.dataset.candidateId = candidate.id;
    if (candidate.itemId) row.dataset.itemId = candidate.itemId;
    const title = document.createElement('label'); title.textContent = 'Candidate idea';
    const input = document.createElement('input'); input.maxLength = 200; input.required = true; input.value = candidate.title; title.append(input);
    const kind = document.createElement('label'); kind.textContent = 'Commitment';
    const select = document.createElement('select');
    select.append(new Option('Brainstorming only', 'brainstorm'), new Option('Action', 'action'), new Option('Bounded learning step', 'learning'));
    select.value = candidate.kind; kind.append(select);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove idea'; remove.setAttribute('aria-label', `Remove candidate idea: ${candidate.title || 'Untitled'}`);
    remove.onclick = () => { row.remove(); active = read(); dirty = true; status('Draft changed — saving on device…'); void journal(); };
    row.append(title, kind, remove); return row;
  }
  function draw() {
    if (!active) return;
    const project = records()[`project:${active.projectId}`];
    $('projectPlanningHeading').textContent = `Plan project: ${project?.title || 'Unavailable project'}`;
    for (const name of ['purposePrinciples', 'desiredEvidence', 'organizationApproach', 'unresolvedQuestions']) form.elements[name].value = active.sections[name] || '';
    $('projectPlanCandidates').replaceChildren(...active.candidates.map(candidateRow));
    const accepted = project?.planningHeadId ? records()[`projectPlanRevision:${project.planningHeadId}`] : null;
    status(accepted && !accepted.localState ? `Editing from accepted revision ${accepted.id}. Ideas remain uncommitted until Accept plan.` : 'Draft saved only on this device until you accept it.');
    $('acceptProjectPlan').disabled = busy || !project || project.deleted || !!project.localState;
  }
  form.addEventListener('input', () => { if (active && !busy) { active = read(); dirty = true; status('Draft changed — saving on device…'); void journal(); } });
  $('addProjectPlanCandidate').onclick = () => {
    if (!active || $('projectPlanCandidates').children.length >= 50) { status('A project plan supports at most 50 candidate ideas.'); return; }
    const row = candidateRow({ id: crypto.randomUUID(), title: '', kind: 'brainstorm' });
    $('projectPlanCandidates').append(row); active = read(); dirty = true; row.querySelector('input').focus(); void journal();
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (busy || !active) return;
    void (async () => {
      try {
        const draft = validateProjectPlanDraft(read());
        active = structuredClone(draft); dirty = true; busy = true; draw();
        if (!await journal()) throw new Error('The latest planning draft was not saved on this device. Copy or export it before leaving.');
        const project = records()[`project:${draft.projectId}`];
        const mutations = projectPlanMutations(project, draft, records());
        await save(mutations, draft);
        active = null; dirty = false; dialog.close();
      } catch (failure) { status(failure.message); }
      finally { busy = false; if (active) draw(); }
    })();
  };
  $('closeProjectPlanning').onclick = () => {
    dialog.close();
    if (dirty) void journal();
    else active = null;
  };
  $('discardProjectPlanning').onclick = () => {
    if (!active || !confirm('Discard this project planning draft from this device? Accepted revisions and canonical actions are unchanged.')) return;
    active = null; dirty = false; dialog.close(); void journal();
  };
  return {
    open(project, draft = null) {
      if (project.deleted) throw new Error('Restore this project before planning it.');
      const discardedOther = active?.projectId !== project.id && dirty;
      if (discardedOther && !confirm('Discard the saved planning draft for the other project and open this one? Accepted revisions and canonical actions are unchanged.')) return;
      const resume = active?.projectId === project.id;
      active = structuredClone(draft || (resume ? read() : draftFromAccepted(project, records())));
      dirty = draft ? true : resume && dirty;
      draw(); showDialog(dialog); form.elements.purposePrinciples.focus();
      if (discardedOther) void journal();
    },
    snapshot() { return active && dirty ? { ...read(), open: dialog.open } : null; },
    restore(saved) {
      active = saved ? structuredClone(saved) : null;
      dirty = !!active;
      if (active) { draw(); if (saved.open) { showDialog(dialog); form.elements.purposePrinciples.focus(); } }
      else if (dialog.open) dialog.close();
    },
    reset() { active = null; dirty = false; form.reset(); $('projectPlanCandidates').replaceChildren(); status(''); if (dialog.open) dialog.close(); },
    render() { if (active) draw(); },
    close() { if (dialog.open) dialog.close(); }
  };
}
