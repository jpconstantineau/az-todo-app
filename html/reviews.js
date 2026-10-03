import { key, projected } from './inbox-store.js?v=30';
import { workflowFields, reviewReady, localDate, taskFields } from './inbox-fields.js?v=30';

const $ = id => document.getElementById(id);
const snapshot = record => record.type === 'project' ? {} : Object.fromEntries(workflowFields.map(name => [name, record[name] ?? (name === 'waitingOn' ? '' : name === 'status' ? 'inbox' : null)]));
const latest = (session, index) => [...session.decisions].reverse().find(entry => entry.index === index);
const done = (session, index) => { const decision = latest(session, index); return decision && decision.choice !== 'undo'; };

export function setupReviews({ current, save, journal, showDialog, records: scopedRecords }) {
  let active = null, selected = null, displayed, busy = false;
  const draft = () => ({ active, selected, deferUntil: $('reviewDefer').value });
  const message = value => { $('reviewError').textContent = value; };
  function render() {
    const state = current();
    if (!state) return;
    const records = scopedRecords ? scopedRecords() : projected(state), sessions = Object.values(records).filter(record => record.type === 'review' && !record.deleted);
    const select = $('reviewSessions');
    select.replaceChildren(new Option('Choose a saved review', ''), ...sessions.map(session => new Option(`${session.reviewKind} · ${session.reviewDay} · ${session.included.filter((_, i) => done(session, i)).length}/${session.included.length}`, session.id)));
    select.value = active || '';
    const session = records[`review:${active}`];
    $('reviewBody').hidden = !session;
    if (!session) { displayed = null; return; }
    const remaining = session.included.findIndex((_, i) => !done(session, i));
    const index = selected ?? (remaining < 0 ? 0 : remaining);
    const ref = session.included[index], target = ref ? records[key(ref)] : null;
    const previous = latest(session, index);
    const progress = `${session.reviewKind} review: ${session.included.filter((_, i) => done(session, i)).length} of ${session.included.length} reviewed. ${session.localState || 'Server-confirmed'}.${remaining < 0 ? ' Review complete.' : ''}`;
    if ($('reviewProgress').textContent !== progress) $('reviewProgress').textContent = progress;
    $('reviewRecord').replaceChildren(...session.included.map((ref, i) => new Option(`${done(session, i) ? 'Reviewed: ' : ''}${records[key(ref)]?.title || 'Unavailable record'} (${ref.type})`, String(i))));
    $('reviewRecord').value = String(index);
    $('reviewTitle').textContent = target?.title || (ref ? 'Unavailable record' : 'Nothing to review');
    $('reviewDetails').textContent = !ref ? 'This review is empty. Start another review after capturing work or changing your focus.' : !target || target.deleted
      ? 'This record was deleted or is unavailable. Acknowledge it to continue; it will not be recreated.'
      : [target.type === 'project' ? `Project outcome: ${target.outcome}` : `Status: ${target.status}`, target.description,
        target.projectId ? `Project: ${records[`project:${target.projectId}`]?.title || 'Unavailable project'}` : '',
        ...['waitingOn', 'plannedDay', 'dueDate', 'dueDateUtc', 'startDate', 'startDateUtc', 'reviewDate', 'reviewDateUtc'].filter(name => target[name]).map(name => `${name}: ${target[name]}`),
        reviewReady(target) ? 'Ready for review' : '', `Record version: ${target.version}`].filter(Boolean).join('\n');
    $('reviewOriginal').textContent = target?.originalText || '';
    const failed = state.queue.some(entry => entry.failure);
    $('reviewRetain').disabled = busy || failed || !target || target.deleted || !!done(session, index);
    $('reviewDrop').disabled = $('reviewDeferSave').disabled = $('reviewRetain').disabled || target?.type !== 'item';
    $('reviewUnavailable').hidden = !ref || target && !target.deleted;
    $('reviewUnavailable').disabled = busy || failed || !!done(session, index);
    $('reviewUndo').disabled = busy || failed || !previous || ['undo', 'unavailable'].includes(previous.choice) || !target || target.deleted || target.version !== previous.recordVersion + 1;
    $('reviewHistory').textContent = session.decisions.length ? session.decisions.map(entry => `${session.included[entry.index].type}:${session.included[entry.index].id} · ${entry.choice} · version ${entry.recordVersion}\nBefore: ${JSON.stringify(entry.before)}\nAfter: ${JSON.stringify(entry.after)}`).join('\n\n') : 'No decisions yet.';
    if (!busy && displayed?.target && target && displayed.target.id === target.id && displayed.target.version !== target.version) message('This record changed. The latest version is shown; review it before deciding.');
    displayed = { session, target, index };
    if (failed) message('A save needs attention. Close this panel to compare the conflict, keep a recovery copy, and use the server version before resuming this review.');
  }
  async function perform(action) {
    if (busy) return;
    const focused = document.activeElement;
    let succeeded = false;
    busy = true; message('');
    const controls = ['reviewSessions', 'reviewRecord', 'startDaily', 'startWeekly'];
    for (const id of controls) $(id).disabled = true;
    try { await action(); succeeded = true; }
    catch (error) { message(error.message); }
    finally {
      busy = false; for (const id of controls) $(id).disabled = false; render();
      // Disabling a saving control can drop focus to body. Do not take focus
      // back if the user closed the dialog or moved to another control.
      if ($('reviews').open && (document.activeElement === document.body || document.activeElement === focused)) {
        (succeeded || focused.disabled ? $('reviewTitle') : focused).focus();
      }
    }
  }
  async function start(reviewKind) {
    const state = current();
    if (!state || state.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before starting a review.');
    const day = localDate(new Date().toISOString()).slice(0, 10);
    const included = Object.values(scopedRecords ? scopedRecords() : projected(state)).filter(record => !record.deleted && (reviewKind === 'weekly' && record.type === 'project' || record.type === 'item' && !['completed', 'dropped'].includes(record.status) &&
      (reviewKind === 'weekly' || record.status === 'next' || record.plannedDay === day || reviewReady(record) || record.dueDate && record.dueDate <= day || record.dueDateUtc && Date.parse(record.dueDateUtc) <= Date.now())))
      .map(({ type, id }) => ({ type, id }));
    if (included.length > 200) throw new Error('This review exceeds 200 records. Complete or drop inactive work before starting; no records have been omitted.');
    const id = crypto.randomUUID();
    await save([{ type: 'review', id, action: 'create', expectedVersion: 0, fields: { reviewKind, reviewDay: day, included, decisions: [] } }]);
    if (!current()) return;
    active = id; selected = null; render(); await journal();
  }
  async function decide(choice) {
    if (!displayed) return;
    const { session, target, index } = displayed;
    const state = current();
    if (!state || state.queue.some(entry => entry.failure)) throw new Error('Resolve the failed save before continuing.');
    if (session.decisions.length >= 200) throw new Error('This review has reached 200 history entries. Its history is kept; start a new review.');
    let fields;
    if (choice === 'retain') fields = { title: target.title };
    if (choice === 'drop') fields = { status: 'dropped' };
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
    const decision = { index, choice, recordVersion: target?.version ?? 0,
      before: fields ? snapshot(target) : {}, after: fields ? snapshot({ ...target, ...fields }) : {} };
    const mutations = [{ type: 'review', id: session.id, action: 'update', expectedVersion: session.version, fields: { decisions: [...session.decisions, decision] } }];
    if (fields) mutations.push({ type: target.type, id: target.id, action: 'update', expectedVersion: target.version, fields });
    await save(mutations);
    if (!current()) return;
    selected = choice === 'undo' ? index : null; $('reviewDefer').value = ''; render(); await journal();
  }
  $('openReviews').onclick = () => { render(); showDialog($('reviews')); $('reviewSessions').focus(); };
  $('closeReviews').onclick = () => $('reviews').close();
  $('startDaily').onclick = () => void perform(() => start('daily'));
  $('startWeekly').onclick = () => void perform(() => start('weekly'));
  $('reviewSessions').onchange = () => { active = $('reviewSessions').value; selected = null; message(''); render(); void journal(); };
  $('reviewRecord').onchange = () => { selected = Number($('reviewRecord').value); message(''); render(); void journal(); };
  $('reviewDefer').oninput = () => void journal();
  for (const [id, choice] of [['reviewRetain', 'retain'], ['reviewDrop', 'drop'], ['reviewDeferSave', 'defer'], ['reviewUnavailable', 'unavailable'], ['reviewUndo', 'undo']]) $(id).onclick = () => void perform(() => decide(choice));
  return { render, draft,
    restore(saved = {}) { active = saved.active || null; selected = saved.selected ?? null; $('reviewDefer').value = saved.deferUntil || ''; render(); },
    reset() { active = selected = displayed = null; $('reviews').close(); $('reviewSessions').replaceChildren(); $('reviewBody').hidden = true; for (const id of ['reviewDetails', 'reviewTitle', 'reviewOriginal', 'reviewHistory', 'reviewProgress', 'reviewError']) $(id).textContent = ''; $('reviewRecord').replaceChildren(); $('reviewDefer').value = ''; }
  };
}
