import { belongsTo, memberships, refKey } from './collection-model.js?v=2';
import { key, projected } from './inbox-store.js?v=9';
import { workflowFields, reviewReady, localDate, taskFields } from './inbox-fields.js?v=2';

const $ = id => document.getElementById(id);
const snapshot = record => record.type === 'project' ? {} : Object.fromEntries(workflowFields.map(name => [name, record[name] ?? (name === 'waitingOn' ? '' : null)]));
const latest = (session, index) => [...session.history].reverse().find(entry => entry.index === index);
const done = (session, index) => { const decision = latest(session, index); return decision && decision.choice !== 'undo'; };
const promptNames = ['mentalSweep', 'calendarCheck', 'roleBalance', 'planReality'];
const blankPrompts = () => Object.fromEntries(promptNames.map(name => [name, { state: 'unanswered', notes: '' }]));
const cloneReflection = reflection => ({ rootReviewId: reflection.reviewId, baseReflectionId: reflection.id,
  prompts: structuredClone(reflection.prompts), conclusion: reflection.conclusion, followUp: null });
const digestId = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
export const reviewReflectionId = (reviewId, previousReflectionId) => digestId(`review-reflection:${previousReflectionId || reviewId}`);
const rootReview = (session, records) => {
  const seen = new Set();
  while (session?.previousReviewId && !seen.has(session.id)) { seen.add(session.id); session = records[`review:${session.previousReviewId}`]; }
  return session;
};
export function reviewReflections(reviewId, records) {
  const remaining = Object.values(records).filter(record => record.type === 'reviewReflection' && record.reviewId === reviewId);
  const ordered = [], seen = new Set();
  let next = remaining.find(record => !record.previousReflectionId);
  while (next && !seen.has(next.id)) {
    ordered.push(next); seen.add(next.id);
    next = remaining.find(record => record.previousReflectionId === next.id);
  }
  return ordered;
}

export async function mergeReflectionConflict(entry, records) {
  const pending = entry?.operation?.mutations.find(mutation => mutation.type === 'reviewReflection');
  const server = pending && records[key(pending)];
  if (!pending || !server || server.deleted) return null;
  const proposal = pending.fields;
  const prompts = Object.fromEntries(promptNames.map(name => {
    const mine = proposal.prompts[name], accepted = server.prompts[name];
    return [name, mine.state !== 'unanswered' || mine.notes ? mine : accepted];
  }));
  const conclusion = !server.conclusion || server.conclusion === proposal.conclusion ? proposal.conclusion : !proposal.conclusion ? server.conclusion : `${server.conclusion}\n\n${proposal.conclusion}`;
  if (conclusion.length > 4000) throw new Error('The combined accepted and pending conclusions exceed 4,000 characters. Export the recovery copy, use the server version, then shorten and save again.');
  const followUpIds = [...new Set([...server.followUpIds, ...proposal.followUpIds])];
  if (followUpIds.length > 50) throw new Error('The combined reflection has more than 50 follow-ups. Use the server version and start another review for additional actions.');
  const id = await reviewReflectionId(server.reviewId, server.id);
  const reflection = { type: 'reviewReflection', id, action: 'create', expectedVersion: 0, fields: {
    reviewId: server.reviewId, previousReflectionId: server.id, promptVersion: 1, prompts, conclusion, followUpIds
  } };
  const related = entry.operation.mutations.filter(mutation => mutation.type === 'item').filter(mutation => !records[key(mutation)]);
  return [reflection, ...related];
}
export function reviewHistory(session, records) {
  return Object.values(records).filter(record => record.type === 'reviewDecision' && record.reviewId === session.id)
    .sort((a, b) => a.sequence - b.sequence).map(record => ({ ...record, after: { ...record.before, ...record.changes } }));
}

export function setupReviews({ current, save, journal, edit, clarify, addAction, openPlan, workspaceId, records: scopedRecords }) {
  let active = null, selected = null, displayed, busy = false;
  let reflectionDraft = null;
  const draft = () => ({ active, selected, deferUntil: $('reviewDefer').value, reflection: reflectionDraft ? structuredClone(reflectionDraft) : null });
  const message = value => { $('reviewError').textContent = value; };
  function candidates(records, reviewKind, day, previous) {
    const seen = new Set(), visited = new Set();
    for (let session = previous; session && !visited.has(session.id); session = records[`review:${session.previousReviewId}`]) {
      visited.add(session.id); session.included.forEach(ref => seen.add(key(ref)));
    }
    const now = new Date(), [year, month, date] = day.split('-').map(Number);
    const tomorrow = new Date(year, month - 1, date + 1).getTime();
    return Object.values(records).filter(record => {
      if (record.deleted || seen.has(key(record))) return false;
      if (record.type === 'project') return reviewKind === 'weekly' && ['active', 'draft'].includes(record.status) || reviewKind === 'someday' && record.status === 'someday';
      if (reviewKind === 'someday' || record.type !== 'item' || ['completed', 'dropped', 'reference'].includes(record.status)) return false;
      return reviewKind === 'weekly' || record.status === 'next' || record.plannedDay === day || reviewReady(record, now) ||
        record.dueDate && record.dueDate <= day || record.dueDateUtc && Date.parse(record.dueDateUtc) < tomorrow;
    }).map(({ type, id }) => ({ type, id }));
  }
  function render() {
    const state = current();
    if (!state) return;
    const records = scopedRecords ? scopedRecords() : projected(state), sessions = Object.values(records).filter(record => record.type === 'review' && !record.deleted)
      .map(session => ({ ...session, history: reviewHistory(session, records) }));
    const select = $('reviewSessions');
    select.replaceChildren(new Option('Choose a saved review', ''), ...sessions.map(session => new Option(`${session.reviewKind} · ${session.reviewDay} · ${session.included.filter((_, i) => done(session, i)).length}/${session.included.length}`, session.id)));
    select.value = active || '';
    const session = sessions.find(session => session.id === active);
    $('reviewBody').hidden = !session;
    if (!session) { displayed = null; return; }
    const root = rootReview(session, records), reflections = reviewReflections(root.id, records), accepted = reflections.at(-1);
    if (reflectionDraft?.rootReviewId !== root.id) reflectionDraft = accepted ? cloneReflection(accepted) : {
      rootReviewId: root.id, baseReflectionId: null, prompts: blankPrompts(), conclusion: '', followUp: null
    };
    const remaining = session.included.findIndex((_, i) => !done(session, i));
    const nextBatch = sessions.find(next => next.previousReviewId === session.id);
    const available = candidates(records, session.reviewKind, session.reviewDay, session).length;
    $('reviewNextBatch').hidden = !nextBatch && !available;
    $('reviewNextBatch').disabled = busy || state.queue.some(entry => entry.failure) || remaining >= 0;
    $('reviewNextBatch').textContent = nextBatch ? 'Open next review batch' : `Review next batch (${available} remaining)`;
    $('reviewCapacity').textContent = nextBatch ? 'This is one batch. Open the next batch to continue; previous batches stay in Saved reviews.' : available
      ? `${available} more eligible records can be reviewed in batches of up to 200. Finish this batch, then choose Review next batch. Earlier decisions and history are kept.` : '';
    const index = selected ?? (remaining < 0 ? 0 : remaining);
    const ref = session.included[index], target = ref ? records[key(ref)] : null;
    const previous = latest(session, index);
    const completion = remaining < 0 ? (available || nextBatch || session.previousReviewId ? ' Batch complete.' : ' Review complete.') : '';
    const progress = `${session.reviewKind} review: ${session.included.filter((_, i) => done(session, i)).length} of ${session.included.length} reviewed. ${session.localState || 'Server-confirmed'}.${completion}`;
    if ($('reviewProgress').textContent !== progress) $('reviewProgress').textContent = progress;
    $('reviewRecord').replaceChildren(...session.included.map((ref, i) => new Option(`${done(session, i) ? 'Reviewed: ' : ''}${records[key(ref)]?.title || 'Unavailable record'} (${ref.type})`, String(i))));
    $('reviewRecord').value = String(index);
    $('reviewTitle').textContent = target?.title || (ref ? 'Unavailable record' : 'Nothing to review');
    $('reviewDetails').textContent = !ref ? 'This review is empty. Start another review after capturing work or changing your focus.' : !target || target.deleted
      ? 'This record was deleted or is unavailable. Acknowledge it to continue; it will not be recreated.'
      : [target.type === 'project' ? `Project status: ${target.status === 'draft' ? 'Needs outcome' : target.status} · Project outcome: ${target.outcome || 'Not supplied yet'}` : `Status: ${target.status}`, target.description,
        memberships(target).map(ref => `Membership: ${records[refKey(ref)]?.title || 'Unavailable collection'}`).join(' · '),
        ...['waitingOn', 'plannedDay', 'dueDate', 'dueDateUtc', 'startDate', 'startDateUtc', 'reviewDate', 'reviewDateUtc'].filter(name => target[name]).map(name => `${name}: ${target[name]}`),
        reviewReady(target) ? 'Ready for review' : '', `Record version: ${target.version}`].filter(Boolean).join('\n');
    $('reviewOriginal').textContent = target?.originalText || '';
    const failed = state.queue.some(entry => entry.failure);
    for (const section of document.querySelectorAll('[data-reflection-prompt]')) {
      const value = reflectionDraft.prompts[section.dataset.reflectionPrompt];
      section.querySelector('select').value = value.state;
      section.querySelector('textarea').value = value.notes;
    }
    $('reviewConclusion').value = reflectionDraft.conclusion;
    const followUp = reflectionDraft.followUp || { title: '', description: '' };
    $('reviewFollowUp').elements.title.value = followUp.title || '';
    $('reviewFollowUp').elements.description.value = followUp.description || '';
    const areas = Object.values(records).filter(record => record.type === 'list' && record.kind === 'area' && !record.deleted).length;
    const projects = Object.values(records).filter(record => record.type === 'project' && !record.deleted && ['active', 'draft'].includes(record.status));
    $('reviewRoleSummary').textContent = `${areas} role/area collection${areas === 1 ? '' : 's'} · ${projects.length} active or unfinished project${projects.length === 1 ? '' : 's'} (${projects.filter(record => record.status === 'draft').length} need an outcome).`;
    const dayPlan = records[`dailyPlan:${workspaceId()}_${session.reviewDay}`];
    const planned = dayPlan ? dayPlan.actionIds.map(id => records[`item:${id}`]).filter(Boolean) : Object.values(records).filter(record => record.type === 'item' && record.plannedDay === session.reviewDay);
    const completed = planned.filter(record => record.status === 'completed').length;
    $('reviewPlanSummary').textContent = dayPlan ? `${planned.length} ordered action${planned.length === 1 ? '' : 's'} in the saved plan for ${session.reviewDay}: ${completed} completed, ${planned.length - completed} unfinished.`
      : `${planned.length} action${planned.length === 1 ? '' : 's'} planned for ${session.reviewDay}; no saved daily plan order exists.`;
    $('reviewSaveReflection').disabled = $('reviewSaveFollowUp').disabled = busy || failed;
    $('reviewReflectionStatus').textContent = accepted ? `${reflections.length} accepted snapshot${reflections.length === 1 ? '' : 's'}. Latest: ${accepted.localState || 'Server-confirmed'}.` : 'No accepted reflection yet. Your draft is saved on this device.';
    $('reviewReflectionHistory').replaceChildren(...reflections.map((reflection, index) => {
      const row = document.createElement('li');
      row.textContent = `Snapshot ${index + 1}: ${promptNames.map(name => `${name} ${reflection.prompts[name].state}`).join(' · ')}${reflection.conclusion ? ` · Conclusion: ${reflection.conclusion}` : ''}`;
      return row;
    }));
    $('reviewFollowUps').replaceChildren(...(accepted?.followUpIds || []).map(id => {
      const item = records[`item:${id}`], row = document.createElement('li'), text = document.createElement('span'), actions = document.createElement('div');
      actions.className = 'actions'; text.textContent = item && !item.deleted ? `${item.title} · ${item.status}` : `Unavailable follow-up · ${id}`; row.append(text);
      if (item && !item.deleted) {
        for (const [label, action] of [['Edit', () => inspect(edit, item)], ['Clarify', () => inspect(clarify, item)], ['Open in Plan', () => openPlan(item.plannedDay || session.reviewDay)]]) {
          const control = document.createElement('button'); control.type = 'button'; control.textContent = label; control.onclick = () => void perform(action); actions.append(control);
        }
        row.append(actions);
      }
      return row;
    }));
    const unavailable = busy || failed || !target || target.deleted;
    $('reviewEdit').disabled = unavailable;
    $('reviewClarify').hidden = target?.type !== 'item';
    $('reviewClarify').disabled = unavailable;
    $('reviewProject').hidden = unavailable || target.type !== 'project';
    $('reviewAddAction').disabled = unavailable;
    const actions = !unavailable && target.type === 'project' ? Object.values(records).filter(record => record.type === 'item' && !record.deleted && belongsTo(record, target) && !['completed', 'dropped', 'reference'].includes(record.status)) : [];
    const nextCount = actions.filter(record => record.status === 'next').length;
    $('reviewProjectSummary').textContent = nextCount ? `${nextCount} next action${nextCount === 1 ? '' : 's'}. Other unfinished actions are shown too.` : 'No next actions. Add one or edit an unfinished action below.';
    $('reviewProjectActions').replaceChildren(...actions.map(record => {
      const row = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.textContent = `${record.title} (${record.status})`;
      button.setAttribute('aria-label', `Edit ${record.title}`);
      button.dataset.focusKey = `review:${key(record)}:edit`;
      button.onclick = () => void perform(() => inspect(edit, record));
      row.append(button); return row;
    }));
    $('reviewRetain').disabled = busy || failed || !target || target.deleted || !!done(session, index);
    $('reviewDrop').disabled = $('reviewDeferSave').disabled = $('reviewRetain').disabled || target?.type !== 'item';
    $('reviewComplete').disabled = $('reviewDrop').disabled || target?.status === 'completed';
    $('reviewNext').disabled = $('reviewDrop').disabled || target?.status === 'next';
    $('reviewUnavailable').hidden = !ref || target && !target.deleted;
    $('reviewUnavailable').disabled = busy || failed || !!done(session, index);
    $('reviewUndo').disabled = busy || failed || !previous || ['undo', 'unavailable'].includes(previous.choice) || !target || target.deleted || target.version !== previous.recordVersion + 1;
    $('reviewHistory').textContent = session.history.length ? session.history.map(entry => `${session.included[entry.index].type}:${session.included[entry.index].id} · ${entry.choice} · version ${entry.recordVersion}\nBefore: ${JSON.stringify(entry.before)}\nAfter: ${JSON.stringify(entry.after)}`).join('\n\n') : 'No decisions yet.';
    if (!busy && displayed?.target && target && displayed.target.id === target.id && displayed.target.version !== target.version) message('This record changed. The latest version is shown; review it before deciding.');
    displayed = { session, target, index };
    if (failed) message('A save needs attention. Compare the conflict in the save card above, keep a recovery copy, and use the server version before resuming this review.');
  }
  async function perform(action) {
    if (busy) return;
    const focused = document.activeElement;
    let succeeded = false;
    busy = true; message('');
    const controls = ['reviewSessions', 'reviewRecord', 'startDaily', 'startWeekly', 'startSomeday', 'reviewNextBatch'];
    for (const id of controls) $(id).disabled = true;
    try { await action(); succeeded = true; }
    catch (error) { message(error.message); }
    finally {
      busy = false; for (const id of controls) $(id).disabled = false; render();
      // Disabling a saving control can drop focus to body. Do not take focus
      // back if the user left the review or moved to another control.
      if (!$('reviews').hidden && (document.activeElement === document.body || document.activeElement === focused)) {
        (succeeded || focused.disabled ? $('reviewTitle') : focused).focus();
      }
    }
  }
  async function start(reviewKind, previous) {
    const state = current();
    if (!state || state.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before starting a review.');
    const records = scopedRecords ? scopedRecords() : projected(state);
    const day = previous?.reviewDay || localDate(new Date().toISOString()).slice(0, 10);
    const next = previous && Object.values(records).find(record => record.type === 'review' && record.previousReviewId === previous.id);
    if (next) { active = next.id; selected = null; render(); await journal(); return; }
    const included = candidates(records, reviewKind, day, previous).slice(0, 200);
    // A deterministic continuation ID makes concurrent next-batch starts conflict safely.
    const id = previous ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(previous.id))), byte => byte.toString(16).padStart(2, '0')).join('') : crypto.randomUUID();
    await save([{ type: 'review', id, action: 'create', expectedVersion: 0, fields: { workspaceId: workspaceId(), reviewKind, reviewDay: day, included,
      decisionHeads: included.map(() => null), decisionCount: 0,
      ...(previous ? { previousReviewId: previous.id } : {}) } }]);
    if (!current()) return;
    active = id; selected = null; render(); await journal();
  }
  async function inspect(action, target = displayed?.target) {
    if (!displayed || !target) return;
    const sessionId = displayed.session.id;
    selected = displayed.index;
    if (!await journal()) throw new Error('Could not save your review position. Your draft is kept.');
    if ($('reviews').hidden) return;
    const state = current(), records = state && (scopedRecords ? scopedRecords() : projected(state));
    const latest = records?.[key(target)];
    if (active !== sessionId || !records?.[`review:${sessionId}`] || !latest || latest.deleted || state.queue.some(entry => entry.failure)) throw new Error('This review or record changed. Inspect the latest state before continuing.');
    action(latest);
  }
  async function decide(choice) {
    if (!displayed) return;
    const { session, target, index } = displayed;
    const state = current();
    if (!state || state.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before continuing.');
    let fields;
    if (choice === 'retain') fields = { title: target.title };
    if (choice === 'drop') fields = { status: 'dropped' };
    if (choice === 'complete') fields = { status: 'completed' };
    if (choice === 'next') fields = { status: 'next' };
    if (choice === 'defer') {
      const day = $('reviewDefer').value;
      if (!day) throw new Error('Choose a calendar date to defer this item.');
      taskFields({ startDate: day });
      fields = { status: 'deferred', startDate: day, startDateUtc: null };
    }
    if (choice === 'undo') {
      const prior = latest(session, index);
      if (!prior || target.version !== prior.recordVersion + 1) throw new Error('This record changed since the decision. Review the latest state instead of undoing.');
      fields = target.type === 'project' || prior.choice === 'retain' ? { title: target.title } : prior.before;
    }
    const before = fields ? snapshot(target) : {}, after = fields ? snapshot({ ...target, ...fields }) : {};
    const id = crypto.randomUUID(), sequence = session.decisionCount + 1;
    const decisionHeads = [...session.decisionHeads];
    decisionHeads[index] = id;
    const decision = { reviewId: session.id, sequence, index, choice, recordVersion: target?.version ?? 0, before,
      changes: Object.fromEntries(Object.entries(after).filter(([name, value]) => value !== before[name])) };
    const mutations = [{ type: 'review', id: session.id, action: 'update', expectedVersion: session.version, fields: { decisionHeads, decisionCount: sequence } },
      { type: 'reviewDecision', id, action: 'create', expectedVersion: 0, fields: decision }];
    if (fields) mutations.push({ type: target.type, id: target.id, action: 'update', expectedVersion: target.version, fields });
    await save(mutations);
    if (!current()) return;
    selected = choice === 'undo' ? index : null; $('reviewDefer').value = ''; render(); await journal();
  }
  async function saveReflection(withFollowUp = false) {
    if (!displayed || !reflectionDraft) return;
    const records = scopedRecords ? scopedRecords() : projected(current()), root = rootReview(displayed.session, records);
    const base = reflectionDraft.baseReflectionId ? records[`reviewReflection:${reflectionDraft.baseReflectionId}`] : null;
    if (reflectionDraft.baseReflectionId && !base) throw new Error('The accepted reflection changed. Sync and review the latest history before saving.');
    const followUp = withFollowUp ? reflectionDraft.followUp : null;
    if (withFollowUp && (!followUp?.title?.trim() || followUp.title.length > 200)) throw new Error('Enter a follow-up title of 1–200 characters.');
    if (withFollowUp && (followUp.description || '').length > 4000) throw new Error('Follow-up notes must be at most 4,000 characters.');
    const followUpId = withFollowUp ? (followUp.id ||= crypto.randomUUID()) : null;
    const followUpIds = [...(base?.followUpIds || [])];
    if (followUpId && !followUpIds.includes(followUpId)) followUpIds.push(followUpId);
    if (followUpIds.length > 50) throw new Error('A reflection supports up to 50 linked follow-ups. Start another review for additional actions.');
    const id = await reviewReflectionId(root.id, reflectionDraft.baseReflectionId);
    const fields = { reviewId: root.id, ...(reflectionDraft.baseReflectionId ? { previousReflectionId: reflectionDraft.baseReflectionId } : {}),
      promptVersion: 1, prompts: structuredClone(reflectionDraft.prompts), conclusion: reflectionDraft.conclusion, followUpIds };
    const mutations = [{ type: 'reviewReflection', id, action: 'create', expectedVersion: 0, fields }];
    if (followUpId) mutations.push({ type: 'item', id: followUpId, action: 'create', expectedVersion: 0, fields: {
      title: followUp.title.trim(), description: followUp.description || '', originalText: followUp.title, workspaceId: workspaceId(), collectionRefs: [], status: 'inbox'
    } });
    const nextReflectionDraft = { ...reflectionDraft, baseReflectionId: id, followUp: withFollowUp ? null : reflectionDraft.followUp };
    const nextDraft = { ...draft(), reflection: structuredClone(nextReflectionDraft) };
    await save(mutations, nextDraft);
    reflectionDraft = nextReflectionDraft;
    render(); await journal();
  }
  $('startDaily').onclick = () => void perform(() => start('daily'));
  $('startWeekly').onclick = () => void perform(() => start('weekly'));
  $('startSomeday').onclick = () => void perform(() => start('someday'));
  $('reviewNextBatch').onclick = () => void perform(() => start(displayed.session.reviewKind, displayed.session));
  $('reviewSessions').onchange = () => { active = $('reviewSessions').value; selected = null; message(''); render(); void journal(); };
  $('reviewRecord').onchange = () => { selected = Number($('reviewRecord').value); message(''); render(); void journal(); };
  $('reviewDefer').oninput = () => void journal();
  for (const section of document.querySelectorAll('[data-reflection-prompt]')) {
    const name = section.dataset.reflectionPrompt, select = section.querySelector('select'), notes = section.querySelector('textarea');
    select.onchange = () => { reflectionDraft.prompts[name].state = select.value; void journal(); };
    notes.oninput = () => { reflectionDraft.prompts[name].notes = notes.value; void journal(); };
  }
  $('reviewConclusion').oninput = () => { reflectionDraft.conclusion = $('reviewConclusion').value; void journal(); };
  for (const name of ['title', 'description']) $('reviewFollowUp').elements[name].oninput = () => {
    reflectionDraft.followUp ||= { id: crypto.randomUUID(), title: '', description: '' };
    reflectionDraft.followUp[name] = $('reviewFollowUp').elements[name].value; void journal();
  };
  $('reviewSaveReflection').onclick = () => void perform(() => saveReflection());
  $('reviewFollowUp').onsubmit = event => { event.preventDefault(); void perform(() => saveReflection(true)); };
  $('reviewOpenPlan').onclick = () => openPlan();
  $('reviewOpenDayPlan').onclick = () => openPlan(displayed?.session.reviewDay);
  $('reviewEdit').onclick = () => void perform(() => inspect(edit));
  $('reviewClarify').onclick = () => void perform(() => inspect(clarify));
  $('reviewAddAction').onclick = () => void perform(() => inspect(addAction));
  for (const [id, choice] of [['reviewRetain', 'retain'], ['reviewDrop', 'drop'], ['reviewComplete', 'complete'], ['reviewNext', 'next'], ['reviewDeferSave', 'defer'], ['reviewUnavailable', 'unavailable'], ['reviewUndo', 'undo']]) $(id).onclick = () => void perform(() => decide(choice));
  return { render, draft, get busy() { return busy; },
    restore(saved = {}) { active = saved.active || null; selected = saved.selected ?? null; reflectionDraft = saved.reflection || null; $('reviewDefer').value = saved.deferUntil || ''; render(); },
    reset() { active = selected = displayed = reflectionDraft = null; $('reviews').hidden = true; $('reviewSessions').replaceChildren(); $('reviewBody').hidden = true; for (const id of ['reviewDetails', 'reviewTitle', 'reviewOriginal', 'reviewHistory', 'reviewProgress', 'reviewCapacity', 'reviewError', 'reviewProjectSummary', 'reviewProjectActions', 'reviewReflectionStatus', 'reviewRoleSummary', 'reviewPlanSummary', 'reviewReflectionHistory', 'reviewFollowUps']) $(id).textContent = ''; $('reviewRecord').replaceChildren(); $('reviewDefer').value = ''; }
  };
}
