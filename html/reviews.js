import { belongsTo, memberships, refKey } from './collection-model.js?v=56';
import { key, projected } from './inbox-store.js?v=56';
import { workflowFields, reviewReady, localDate, taskFields } from './inbox-fields.js?v=56';

const $ = id => document.getElementById(id);
const snapshot = record => record.type === 'project' ? {} : Object.fromEntries(workflowFields.map(name => [name, record[name] ?? (name === 'waitingOn' ? '' : name === 'status' ? 'inbox' : null)]));
const latest = (session, index) => [...session.decisions].reverse().find(entry => entry.index === index);
const done = (session, index) => { const decision = latest(session, index); return decision && decision.choice !== 'undo'; };
export function reviewHistory(session, records) {
  return [...session.decisions, ...Object.values(records).filter(record => record.type === 'reviewDecision' && record.reviewId === session.id)
    .sort((a, b) => a.sequence - b.sequence).map(record => ({ ...record, after: { ...record.before, ...record.changes } }))];
}

export function setupReviews({ current, save, journal, edit, clarify, addAction, records: scopedRecords }) {
  let active = null, selected = null, displayed, busy = false;
  const draft = () => ({ active, selected, deferUntil: $('reviewDefer').value });
  const message = value => { $('reviewError').textContent = value; };
  function candidates(records, reviewKind, day, previous) {
    const seen = new Set(), visited = new Set();
    for (let session = previous; session && !visited.has(session.id); session = records[`review:${session.previousReviewId}`]) {
      visited.add(session.id); session.included.forEach(ref => seen.add(key(ref)));
    }
    const now = new Date(), [year, month, date] = day.split('-').map(Number);
    const tomorrow = new Date(year, month - 1, date + 1).getTime();
    return Object.values(records).filter(record => !record.deleted && !seen.has(key(record)) && (reviewKind === 'weekly' && record.type === 'project' || record.type === 'item' && !['completed', 'dropped', 'reference'].includes(record.status) &&
      (reviewKind === 'weekly' || record.status === 'next' || record.plannedDay === day || reviewReady(record, now) || record.dueDate && record.dueDate <= day || record.dueDateUtc && Date.parse(record.dueDateUtc) < tomorrow)))
      .map(({ type, id }) => ({ type, id }));
  }
  function render() {
    const state = current();
    if (!state) return;
    const records = scopedRecords ? scopedRecords() : projected(state), sessions = Object.values(records).filter(record => record.type === 'review' && !record.deleted)
      .map(session => ({ ...session, decisions: reviewHistory(session, records) }));
    const select = $('reviewSessions');
    select.replaceChildren(new Option('Choose a saved review', ''), ...sessions.map(session => new Option(`${session.reviewKind} · ${session.reviewDay} · ${session.included.filter((_, i) => done(session, i)).length}/${session.included.length}`, session.id)));
    select.value = active || '';
    const session = sessions.find(session => session.id === active);
    $('reviewBody').hidden = !session;
    if (!session) { displayed = null; return; }
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
      : [target.type === 'project' ? `Project outcome: ${target.outcome}` : `Status: ${target.status}`, target.description,
        memberships(target).map(ref => `Membership: ${records[refKey(ref)]?.title || 'Unavailable collection'}`).join(' · '),
        ...['waitingOn', 'plannedDay', 'dueDate', 'dueDateUtc', 'startDate', 'startDateUtc', 'reviewDate', 'reviewDateUtc'].filter(name => target[name]).map(name => `${name}: ${target[name]}`),
        reviewReady(target) ? 'Ready for review' : '', `Record version: ${target.version}`].filter(Boolean).join('\n');
    $('reviewOriginal').textContent = target?.originalText || '';
    const failed = state.queue.some(entry => entry.failure);
    const unavailable = busy || failed || !target || target.deleted;
    $('reviewEdit').disabled = unavailable;
    $('reviewClarify').hidden = target?.type !== 'item' || target.status === 'reference';
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
    $('reviewHistory').textContent = session.decisions.length ? session.decisions.map(entry => `${session.included[entry.index].type}:${session.included[entry.index].id} · ${entry.choice} · version ${entry.recordVersion}\nBefore: ${JSON.stringify(entry.before)}\nAfter: ${JSON.stringify(entry.after)}`).join('\n\n') : 'No decisions yet.';
    if (!busy && displayed?.target && target && displayed.target.id === target.id && displayed.target.version !== target.version) message('This record changed. The latest version is shown; review it before deciding.');
    displayed = { session, target, index };
    if (failed) message('A save needs attention. Compare the conflict in the save card above, keep a recovery copy, and use the server version before resuming this review.');
  }
  async function perform(action) {
    if (busy) return;
    const focused = document.activeElement;
    let succeeded = false;
    busy = true; message('');
    const controls = ['reviewSessions', 'reviewRecord', 'startDaily', 'startWeekly', 'reviewNextBatch'];
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
    await save([{ type: 'review', id, action: 'create', expectedVersion: 0, fields: { reviewKind, reviewDay: day, included, decisions: [],
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
    const id = crypto.randomUUID(), sequence = (session.decisionCount || 0) + 1;
    const decisionHeads = session.decisionHeads ? [...session.decisionHeads] : session.included.map(() => null);
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
  $('startDaily').onclick = () => void perform(() => start('daily'));
  $('startWeekly').onclick = () => void perform(() => start('weekly'));
  $('reviewNextBatch').onclick = () => void perform(() => start(displayed.session.reviewKind, displayed.session));
  $('reviewSessions').onchange = () => { active = $('reviewSessions').value; selected = null; message(''); render(); void journal(); };
  $('reviewRecord').onchange = () => { selected = Number($('reviewRecord').value); message(''); render(); void journal(); };
  $('reviewDefer').oninput = () => void journal();
  $('reviewEdit').onclick = () => void perform(() => inspect(edit));
  $('reviewClarify').onclick = () => void perform(() => inspect(clarify));
  $('reviewAddAction').onclick = () => void perform(() => inspect(addAction));
  for (const [id, choice] of [['reviewRetain', 'retain'], ['reviewDrop', 'drop'], ['reviewComplete', 'complete'], ['reviewNext', 'next'], ['reviewDeferSave', 'defer'], ['reviewUnavailable', 'unavailable'], ['reviewUndo', 'undo']]) $(id).onclick = () => void perform(() => decide(choice));
  return { render, draft, get busy() { return busy; },
    restore(saved = {}) { active = saved.active || null; selected = saved.selected ?? null; $('reviewDefer').value = saved.deferUntil || ''; render(); },
    reset() { active = selected = displayed = null; $('reviews').hidden = true; $('reviewSessions').replaceChildren(); $('reviewBody').hidden = true; for (const id of ['reviewDetails', 'reviewTitle', 'reviewOriginal', 'reviewHistory', 'reviewProgress', 'reviewCapacity', 'reviewError', 'reviewProjectSummary', 'reviewProjectActions']) $(id).textContent = ''; $('reviewRecord').replaceChildren(); $('reviewDefer').value = ''; }
  };
}
