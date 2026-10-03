import { localGuidance } from './local-guidance.js?v=35';

// Proposals stay separate from action fields until the user accepts a question.
export const questions = [
  ['outcome', 'What outcome would resolve this?', 'Describe what done looks like. This records an outcome here; it does not create a project.'],
  ['nextAction', 'What is one concrete next action?', 'Accepting replaces the task title with your wording. Its status stays unchanged until you decide below.'],
  ['missingFacts', 'What information is still missing?', 'Name the unknowns, or intentionally enter “None known”. Skipping leaves this unanswered.'],
  ['disposition', 'What should happen next?', 'Keep the current state, choose Next, wait for a person or dependency, or defer until a date.']
];
export const emptyProposal = () => ({ text: '', status: '', waitingOn: '', reviewDate: '', startDate: '' });

export function decision(session, proposal, choice) {
  const name = questions[session.step]?.[0];
  if (!name) throw new Error('This clarification is complete.');
  let value = null, fields = null;
  if (choice === 'accepted') {
    if (name === 'disposition') {
      const { status, waitingOn, reviewDate, startDate } = proposal;
      if (!['keep', 'next', 'waiting', 'deferred'].includes(status)) throw new Error('Choose what should happen next, or skip.');
      if (status === 'waiting' && (!waitingOn.trim() || !reviewDate)) throw new Error('Waiting needs who/what you await and a review date.');
      if (status === 'deferred' && !startDate) throw new Error('Deferred needs a start date.');
      value = { status, waitingOn: status === 'waiting' ? waitingOn : '', reviewDate: status === 'waiting' ? reviewDate : '', startDate: status === 'deferred' ? startDate : '' };
      if (status !== 'keep') fields = { status,
        ...(status === 'waiting' ? { waitingOn, reviewDate, reviewDateUtc: null } : {}),
        ...(status === 'deferred' ? { startDate, startDateUtc: null } : {}) };
    } else {
      value = proposal.text;
      if (!value.trim() || value.length > (name === 'nextAction' ? 200 : 4000)) throw new Error(`Enter an answer of 1–${name === 'nextAction' ? 200 : 4000} characters, or skip.`);
      if (name === 'nextAction') fields = { title: value };
    }
  } else if (choice !== 'skipped') throw new Error('Choose accept or skip.');
  return { session: { step: session.step + 1, answers: { ...session.answers, [name]: { decision: choice, value } }, proposal: emptyProposal() }, fields };
}

export function clarificationUI({ records, save, journal, showDialog }) {
  const $ = id => document.getElementById(id);
  const dialog = $('clarifier'), form = $('clarifyForm');
  let active = null, busy = false;
  const values = () => Object.fromEntries([...form.elements].filter(input => input.name).map(input => [input.name, input.value]));
  const snapshot = () => active ? { ...structuredClone(active), proposal: values(), open: dialog.open } : null;
  const guidance = localGuidance({
    context: () => active && dialog.open && !busy && active.session.step < 3 ? {
      question: questions[active.session.step][1], limit: active.session.step === 1 ? 200 : 4000,
      task: { title: active.item.title, description: active.item.description || '', originalText: active.item.originalText || active.item.title },
      acceptedAnswers: active.session.answers, proposedAnswer: values().text
    } : null,
    use(text) { form.elements.text.value = text; form.elements.text.focus(); void journal(); }
  });
  function draw() {
    const step = active.session.step, question = questions[step];
    $('clarifyHeading').textContent = question ? `Question ${step + 1} of ${questions.length}` : 'Clarification complete';
    $('clarifyOriginal').textContent = active.item.originalText || active.item.title;
    $('clarifyTask').textContent = `Current task: ${active.item.title}`;
    $('clarifyQuestion').textContent = question?.[1] || 'Your decisions';
    $('clarifyHelp').textContent = question?.[2] || 'Accepted decisions are saved below. Ordinary editing remains available for the task.';
    $('clarifyTextLabel').hidden = !question || step === 3;
    $('clarifyDisposition').hidden = step !== 3;
    $('clarifyAccept').hidden = $('clarifySkip').hidden = $('clarifySave').hidden = !question;
    form.elements.text.maxLength = step === 1 ? 200 : 4000;
    for (const [name, value] of Object.entries(active.proposal)) form.elements.namedItem(name).value = value;
    $('clarifyAnswers').textContent = questions.map(([name, label]) => {
      const answer = active.session.answers[name];
      return `${label}\n${answer?.decision === 'accepted' ? (typeof answer.value === 'string' ? answer.value : Object.entries(answer.value).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join('; ')) : answer ? 'Unknown — skipped' : 'Unknown — unanswered'}`;
    }).join('\n\n');
    $('clarifyError').hidden = true;
    $('clarifyDraftStatus').textContent = '';
    $('clarifyQuestion').focus();
  }
  async function commit(choice) {
    if (busy || !active || active.session.step === questions.length) return;
    guidance.hide();
    busy = true;
    const current = active, proposal = values(), focused = document.activeElement;
    [...form.elements].forEach(input => { input.disabled = true; });
    try {
      const result = choice ? decision(current.session, proposal, choice) : { session: { ...current.session, proposal }, fields: null };
      const { step, answers } = result.session;
      const fields = { step, answers, proposal: result.session.proposal };
      const mutations = [{ type: 'clarification', id: current.item.id, action: current.session.version ? 'update' : 'create', expectedVersion: current.session.version, fields }];
      if (result.fields) mutations.push({ type: 'item', id: current.item.id, action: 'update', expectedVersion: current.item.version, fields: result.fields });
      const next = { item: { ...current.item, ...result.fields, version: current.item.version + (result.fields ? 1 : 0) },
        session: { ...fields, version: current.session.version + 1 }, proposal: fields.proposal, open: true };
      if (!await save(mutations, next) || active !== current) return;
      active = next; draw();
      $('clarifyDraftStatus').textContent = 'Saved on device — pending server confirmation. Close to see sync status.';
    } catch (error) {
      if (active === current) { $('clarifyError').textContent = error.message; $('clarifyError').hidden = false; }
    } finally {
      busy = false; [...form.elements].forEach(input => { input.disabled = false; });
      if (dialog.open && active) void guidance.check();
      if (dialog.open && active === current && document.activeElement === document.body) focused.focus();
    }
  }
  form.addEventListener('input', () => { guidance.invalidate(); void journal(); });
  form.addEventListener('submit', event => { event.preventDefault(); void commit('accepted'); });
  $('clarifySkip').onclick = () => { void commit('skipped'); };
  $('clarifySave').onclick = () => { void commit(); };
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
        active = { item: structuredClone(item), session: session || { version: 0, step: 0, answers: {}, proposal: emptyProposal() }, proposal: session?.proposal || emptyProposal() };
      } else { active.proposal = values(); active.item = structuredClone(item); }
      showDialog(dialog);
      draw(); void guidance.check(); void journal();
    },
    restore(saved) {
      if (!saved) return;
      active = saved; draw();
      if (saved.open) { showDialog(dialog); $('clarifyQuestion').focus(); void guidance.check(); }
    },
    hide() { guidance.hide(); active = null; dialog.close(); form.reset(); $('clarifyTask').textContent = $('clarifyOriginal').textContent = $('clarifyAnswers').textContent = $('clarifyError').textContent = $('clarifyDraftStatus').textContent = ''; },
    close() { guidance.hide(); dialog.close(); }
  };
}
