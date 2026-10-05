import { organizer, selectedRefs, membershipFields } from './collections.js?v=2';
import { memberships, refKey } from './collection-model.js?v=2';
import { localGuidance } from './local-guidance.js?v=1';
import { flowProposal, newFlow, flowDecision, flowEdits } from './clarification-flow.js?v=2';

export function clarificationUI({ records, save, journal, showDialog }) {
  const $ = id => document.getElementById(id);
  const dialog = $('clarifier'), form = $('clarifyForm');
  let active = null, busy = false;
  const complete = () => active?.session.step === 'complete';
  const values = () => ({ ...active.proposal, ...Object.fromEntries([...form.elements]
    .filter(input => input.name.startsWith('flow_') && (input.type !== 'radio' || input.checked)).map(input => [input.name.slice(5), input.multiple ? selectedRefs(input) : input.value])) });
  const snapshot = () => active ? { ...structuredClone(active), proposal: values(), open: dialog.open } : null;
  const guidance = localGuidance({
    context: () => active && dialog.open && !busy && active.session.step === 'nextAction' ? {
      question: 'What is one concrete next action?', limit: 200,
      task: { title: active.item.title, description: active.item.description || '', originalText: active.item.originalText || active.item.title },
      acceptedAnswers: active.session.answers, proposedAnswer: values().text
    } : null,
    use(text) { const input = form.elements.flow_text; input.value = text; input.focus(); void journal(); }
  });
  function drawFlow() {
    const { step, answers } = active.session, p = active.proposal, container = $('clarifyFlow');
    container.replaceChildren();
    const labels = { actionable: 'Is it actionable?', nextAction: 'What is one concrete next action?', project: 'Does it require multiple steps, or belong to a project?', twoMinutes: 'Will it take less than two minutes?', disposition: answers.actionable === 'no' ? 'What should happen to this information?' : 'What happens to this action?', organize: 'Where does it belong?', summary: 'Review and apply your decision', complete: 'Clarification complete' };
    $('clarifyHeading').textContent = step === 'complete' ? labels.complete : answers.actionable === 'no' ? 'Clarify · Non-actionable' : answers.actionable === 'yes' ? 'Clarify · Actionable' : 'Clarify · What is it?';
    $('clarifyQuestion').textContent = labels[step];
    $('clarifyHelp').textContent = step === 'complete' ? 'Your decision has been applied. Clarify again starts a fresh pass; the current item stays saved until you apply another decision.' : step === 'twoMinutes' ? 'If yes, do it now. Confirm you have done it on the next step, or choose to do it later.' : step === 'project' ? 'For multi-step work, choose or create its project. For a single action, a project is optional. Stop for now if you have not decided.' : step === 'summary' ? 'Only Apply decision changes the item. Existing links and dates are retained unless shown as changed.' : 'Your answers remain a proposal until the final confirmation. Stop for now to keep your place.';
    function field(name, label, options, type = 'text', max = 4000) {
      const wrapper = document.createElement('label'); wrapper.textContent = label;
      const input = document.createElement(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
      input.name = 'flow_' + name;
      if (options) input.replaceChildren(...options.map(([value, title]) => new Option(title, value)));
      else if (type !== 'textarea') input.type = type;
      if (type === 'date') { input.min = '0001-01-01'; input.max = '9999-12-31'; }
      else input.maxLength = max;
      input.value = p[name] || ''; wrapper.append(input); container.append(wrapper);
      return input;
    }
    function destinations(type, selected) {
      const list = Object.values(records()).filter(record => record.type === type && !record.deleted).map(record => [record.id, record.title]);
      if (selected && !list.some(([id]) => id === selected)) list.push([selected, 'Unavailable — choose another destination']);
      return list;
    }
    if (['actionable', 'twoMinutes'].includes(step)) {
      const group = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = labels[step]; group.append(legend);
      for (const choice of ['yes', 'no']) { const label = document.createElement('label'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'flow_choice'; radio.value = choice; radio.checked = p.choice === choice; label.append(radio, choice === 'yes' ? 'Yes' : 'No'); group.append(label); }
      container.append(group);
    }
    if (step === 'nextAction') field('text', 'Proposed next action', null, 'textarea', 200);
    if (step === 'project') {
      field('choice', 'Project relationship', [['', 'Choose a relationship'], ...(active.item.projectId ? [['keep', 'Keep current project']] : []), ['none', 'Standalone action'], ['existing', 'Choose existing project'], ['new', 'Create a project']]);
      if (p.choice === 'existing') field('projectId', 'Project', [['', 'Choose a project'], ...destinations('project', p.projectId)]);
      if (p.choice === 'new') { field('projectTitle', 'New project title', null, 'text', 200); field('outcome', 'Desired outcome', null, 'textarea'); }
    }
    if (step === 'disposition') {
      field('choice', 'Decision', [['', 'Choose a decision'], ...(answers.actionable === 'no' ? [['someday', 'Incubate — Someday / maybe'], ['reference', 'File as reference'], ['trash', 'Move to Deleted (recoverable)']] : [...(answers.twoMinutes === 'yes' ? [['completed', 'I have done it']] : []), ['next', 'Do when possible / do later instead'], ['waiting', 'Delegate — Waiting'], ['planned', 'Schedule — Plan for a day'], ['deferred', 'Schedule — Not before a date'], ['dropped', 'Drop — abandon this action']])]);
      if (p.choice === 'waiting') field('waitingOn', 'Waiting for (person or dependency)');
      if (['waiting', 'someday'].includes(p.choice)) field('reviewDate', p.choice === 'someday' ? 'Reconsider on (optional; blank means no date)' : 'Follow up on (optional; blank keeps the existing cue)', null, 'date');
      if (p.choice === 'planned') field('plannedDay', 'Planned day (not a deadline)', null, 'date');
      if (p.choice === 'deferred') field('startDate', 'Not before', null, 'date');
    }
    if (step === 'organize') {
      field('text', 'Working title', null, 'text', 200);
      const refs = p.collectionRefs || memberships(active.item);
      const selection = organizer(container, records(), refs, 'flow_collectionRefs');
      const primaryList = field('listId', 'Primary list (defaults)', [['', 'No list'], ...destinations('list', p.listId)]);
      const primaryProject = field('projectId', 'Primary project', [['', 'No project'], ...destinations('project', p.projectId)]);
      primaryList.closest('label').hidden = primaryProject.closest('label').hidden = true;
      selection.onchange = () => {
        const fields = membershipFields(selectedRefs(selection), { listId: primaryList.value, projectId: primaryProject.value });
        primaryList.value = fields.listId || ''; primaryProject.value = fields.projectId || ''; void journal();
      };
      field('notes', 'Missing information / clarification notes (optional)', null, 'textarea');
    }
    if (['summary', 'complete'].includes(step)) {
      const d = answers.disposition, fields = d.choice === 'trash' ? {} : flowEdits(answers), final = { ...active.item, ...fields };
      const name = (type, id) => id ? records()[`${type}:${id}`]?.title || 'Unavailable destination' : 'None';
      const summary = document.createElement('pre');
      summary.textContent = [d.choice === 'trash' ? 'Move the original item to Deleted. It can be restored.' : `Title: ${final.title}\nState: ${final.status}\nList: ${name('list', final.listId)}\nProject: ${answers.project?.choice === 'new' ? answers.project.projectTitle + '\nDesired outcome: ' + answers.project.outcome : name('project', final.projectId)}`,
        `Organize in: ${memberships(final).map(ref => records()[refKey(ref)]?.title || 'Unavailable collection').join(', ') || 'None'}`,
        ...['waitingOn', 'plannedDay', 'startDate', 'startDateUtc', 'reviewDate', 'reviewDateUtc', 'dueDate', 'dueDateUtc'].filter(key => final[key]).map(key => `${({ waitingOn: 'Waiting for', plannedDay: 'Planned day', startDate: 'Not before', startDateUtc: 'Not before (UTC)', reviewDate: 'Review date', reviewDateUtc: 'Review time (UTC)', dueDate: 'Deadline', dueDateUtc: 'Deadline (UTC)' })[key]}: ${final[key]}`), answers.organize?.notes ? `Clarification notes: ${answers.organize.notes}` : '', 'Original capture and existing item notes are preserved.'].filter(Boolean).join('\n');
      container.append(summary);
    }
    $('clarifyBack').hidden = ['actionable', 'complete'].includes(step);
    $('clarifyAccept').textContent = step === 'summary' ? answers.disposition.choice === 'trash' ? 'Move to Deleted' : 'Apply decision' : 'Continue';
    $('clarifyStop').textContent = step === 'complete' ? 'Done' : 'Stop for now';
    $('clarifyAccept').hidden = $('clarifySave').hidden = step === 'complete';
    $('clarifyAnswers').textContent = Object.entries(answers).map(([name, value]) => `${labels[name] || name}\n${typeof value === 'string' ? value : Object.entries(value).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join('\n')}`).join('\n\n');
  }
  function draw() {
    $('clarifyRestart').hidden = !complete();
    $('clarifyOriginal').textContent = active.item.originalText || active.item.title;
    $('clarifyTask').textContent = `Current item: ${active.item.title}`;
    drawFlow(); $('clarifyError').hidden = true; $('clarifyDraftStatus').textContent = ''; $('clarifyQuestion').focus();
  }
  async function commit(choice) {
    if (busy || !active || (complete() ? choice !== 'restart' : choice === 'restart')) return;
    guidance.hide();
    busy = true;
    const current = active, proposal = values(), focused = document.activeElement;
    [...form.elements].forEach(input => { input.disabled = true; });
    try {
      if (choice === 'back' && !confirm('Go back and clear the preceding answer? Current unsaved wording will be discarded; task changes have not been applied.')) return;
      const applying = choice === 'accepted' && current.session.step === 'summary';
      const session = choice === 'restart' ? newFlow() : applying ? { ...current.session, step: 'complete', proposal: flowProposal() } : choice ? flowDecision(current.session, proposal, choice, current.item) : { ...current.session, proposal };
      const { flowVersion, step, answers } = session, fields = { flowVersion, step, answers, proposal: session.proposal };
      const mutations = [{ type: 'clarification', id: current.item.id, action: current.session.version ? 'update' : 'create', expectedVersion: current.session.version, fields }];
      let edits = null;
      if (applying) {
        const deleting = answers.disposition.choice === 'trash';
        if (!deleting) {
          edits = flowEdits(answers);
          if (answers.project?.choice === 'new') {
            edits.projectId = crypto.randomUUID();
            if (edits.collectionRefs) edits.collectionRefs = [...edits.collectionRefs, { type: 'project', id: edits.projectId }];
            mutations.push({ type: 'project', id: edits.projectId, action: 'create', expectedVersion: 0, fields: { title: answers.project.projectTitle, outcome: answers.project.outcome, workspaceId: current.item.workspaceId, status: 'active' } });
          }
        }
        mutations.push({ type: 'item', id: current.item.id, action: deleting ? 'delete' : 'update', expectedVersion: current.item.version, ...(!deleting ? { fields: edits } : {}) });
      }
      const next = { item: { ...current.item, ...edits, version: current.item.version + (applying ? 1 : 0) }, session: { ...fields, version: current.session.version + 1 }, proposal: fields.proposal, open: true };
      if (!await save(mutations, next) || active !== current) return;
      active = next; draw(); $('clarifyDraftStatus').textContent = 'Saved on device — pending server confirmation.';
    } catch (error) {
      if (active === current) { $('clarifyError').textContent = error.message; $('clarifyError').hidden = false; }
    } finally {
      busy = false; [...form.elements].forEach(input => { input.disabled = false; });
      if (dialog.open && active) void guidance.check();
      if (dialog.open && active === current && document.activeElement === document.body) focused.focus();
    }
  }
  form.addEventListener('input', () => { guidance.invalidate(); void journal(); });
  form.addEventListener('change', event => {
    if (event.target.name !== 'flow_choice') return;
    active.proposal = values(); drawFlow();
    const control = form.elements.flow_choice;
    if (control?.focus) control.focus(); else [...control || []].find(input => input.checked)?.focus();
    void journal();
  });
  form.addEventListener('submit', event => { event.preventDefault(); void commit('accepted'); });
  $('clarifySave').onclick = () => { void commit(); };
  $('clarifyBack').onclick = () => { void commit('back'); };
  $('clarifyRestart').onclick = () => { void commit('restart'); };
  $('clarifyStop').onclick = () => { guidance.hide(); dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else guidance.hide(); });
  dialog.addEventListener('close', () => { guidance.hide(); if (active) void journal(); });
  window.addEventListener('pagehide', () => guidance.hide());
  document.addEventListener('visibilitychange', () => { if (document.hidden) guidance.hide(); else if (dialog.open) void guidance.check(); });
  return {
    snapshot,
    open(item) {
      // ponytail: one active form, like the editor; keep it until saved before switching tasks.
      if (active && active.item.id !== item.id && JSON.stringify(values()) !== JSON.stringify(active.session.proposal)) {
        showDialog(dialog);
        $('clarifyError').textContent = 'Save this proposal before clarifying another task. Your answer is still here.';
        $('clarifyError').hidden = false; $('clarifyQuestion').focus(); return;
      }
      const session = records()[`clarification:${item.id}`];
      if (active?.item.id !== item.id || active.session.version !== (session?.version || 0)) {
        active = { item: structuredClone(item), session: session || { version: 0, ...newFlow() }, proposal: session?.proposal || flowProposal() };
      } else { active.proposal = values(); active.item = structuredClone(item); }
      showDialog(dialog);
      draw(); void guidance.check(); void journal();
    },
    restore(saved) {
      if (!saved) return;
      active = saved; draw();
      if (saved.open) { showDialog(dialog); $('clarifyQuestion').focus(); void guidance.check(); }
    },
    hide() { guidance.hide(); active = null; dialog.close(); form.reset(); $('clarifyFlow').replaceChildren(); $('clarifyTask').textContent = $('clarifyOriginal').textContent = $('clarifyAnswers').textContent = $('clarifyError').textContent = $('clarifyDraftStatus').textContent = ''; },
    close() { guidance.hide(); dialog.close(); }
  };
}
