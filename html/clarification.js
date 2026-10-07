import { collectionKinds, collectionKind, isCollection, memberships, ancestry, refKey } from './collection-model.js?v=3';
import { localGuidance } from './local-guidance.js?v=1';
import { newFlow, flowProposal, requireTitle, membershipChange, itemFields, beforeFields } from './clarification-flow.js?v=4';

export function clarificationUI({ records, save, journal, showDialog, actions }) {
  const $ = id => document.getElementById(id);
  const dialog = $('clarifier'), form = $('clarifyForm');
  let active = null, busy = false;
  const currentSession = item => {
    const saved = records()[`clarification:${item.id}`];
    const fresh = newFlow(item);
    return { ...fresh, version: saved?.version || 0 };
  };
  const snapshot = () => active ? { ...structuredClone(active), proposal: values(), open: dialog.open } : null;
  const values = () => {
    if (!active?.item) return active?.proposal || flowProposal();
    const proposal = { ...active.proposal };
    for (const input of form.querySelectorAll('[data-proposal]')) {
      proposal[input.dataset.proposal] = input.type === 'radio' ? (input.checked ? input.value : proposal[input.dataset.proposal]) : input.value;
    }
    return proposal;
  };
  const guidance = localGuidance({
    context: () => active?.item && dialog.open && !busy && values().view === 'action' ? {
      question: 'What is the next visible action?', limit: 200,
      task: { title: active.item.title, description: active.item.description || '', originalText: active.item.originalText || active.item.title },
      acceptedAnswers: {}, proposedAnswer: values().title
    } : null,
    use(text) {
      active.proposal.title = text;
      const input = form.querySelector('[data-proposal=title]');
      if (input) { input.value = text; input.focus(); }
      void journal();
    }
  });

  const element = (name, properties = {}) => Object.assign(document.createElement(name), properties);
  function control(text, handler, className = '') {
    const button = element('button', { type: 'button', textContent: text, className });
    button.onclick = () => void perform(handler);
    return button;
  }
  function labeledInput(name, label, type = 'text', required = false) {
    const wrapper = element('label', { textContent: label }), input = element('input', { type, value: active.proposal[name] || '', required });
    input.dataset.proposal = name;
    if (type === 'date') { input.min = '0001-01-01'; input.max = '9999-12-31'; }
    else input.maxLength = name === 'title' ? 200 : 4000;
    wrapper.append(input); return wrapper;
  }
  function question(text) {
    const heading = element('h3', { id: 'clarifyQuestion', tabIndex: -1, textContent: text });
    heading.dataset.focusKey = 'question';
    return heading;
  }
  function collectionPath(record) {
    const parents = ancestry(record, records()).slice(1).reverse().map(ref => records()[refKey(ref)]?.title).filter(Boolean);
    return [...parents, record.title].join(' / ');
  }
  function availableCollections() {
    const query = active.proposal.search.trim().toLocaleLowerCase();
    const recent = new Set(active.recentRefs || []);
    return Object.values(records()).filter(record => isCollection(record) && !record.deleted && (!query || `${record.title} ${collectionKind(record)} ${collectionPath(record)}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => Number(memberships(active.item).some(ref => refKey(ref) === refKey(b))) - Number(memberships(active.item).some(ref => refKey(ref) === refKey(a))) ||
        Number(recent.has(refKey(b))) - Number(recent.has(refKey(a))) || a.title.localeCompare(b.title));
  }
  function destinationSurface(container) {
    const search = labeledInput('search', 'Search lists and projects');
    search.querySelector('input').dataset.focusKey = 'search';
    const list = element('div', { className: 'clarify-destinations' });
    const none = control('No parent', clearDestination, 'clarify-destination');
    none.dataset.focusKey = 'destination:none';
    none.setAttribute('aria-pressed', String(!active.proposal.parentRef));
    list.append(none);
    for (const destination of availableCollections()) {
      const row = control(`${destination.title} · ${collectionKinds[collectionKind(destination)]}${collectionPath(destination) === destination.title ? '' : ` · ${collectionPath(destination)}`}`, () => chooseDestination(destination), 'clarify-destination');
      row.dataset.focusKey = `destination:${refKey(destination)}`;
      row.setAttribute('aria-label', `Use ${collectionPath(destination)} as parent`);
      row.setAttribute('aria-pressed', String(refKey(active.proposal.parentRef || {}) === refKey(destination)));
      list.append(row);
    }
    if (list.childElementCount === 1 && active.proposal.search) list.append(element('p', { className: 'muted', textContent: 'No matching destinations.' }));
    container.append(search, list);
  }
  function drawClassify(container) {
    const grid = element('div', { className: 'clarify-grid' });
    const configured = actions();
    for (const entry of configured.filter(entry => entry.placement === 'primary')) grid.append(actionControl(entry));
    const extras = element('div', { className: 'clarify-grid' });
    for (const entry of configured.filter(entry => entry.placement === 'more')) extras.append(actionControl(entry));
    if (extras.childElementCount) {
      const more = element('details'), summary = element('summary', { textContent: 'More' });
      more.append(summary, extras); grid.append(more);
    }
    container.append(question('What is this?'), grid); destinationSurface(container);
  }
  function actionControl(entry) {
    const behavior = entry.behavior;
    if (behavior.startsWith('make-')) return control(makeLabel(entry.label), () => convert(behavior.slice(5)));
    if (['action', 'reference', 'someday'].includes(behavior)) {
      const button = control(entry.label, () => setView(behavior)); button.dataset.focusKey = `view:${behavior}`; return button;
    }
    return control(entry.label, trash, 'danger-button');
  }
  function drawItemDecision(container) {
    const view = active.proposal.view, back = control('Back to choices', () => setView('classify', `view:${view}`));
    container.append(back, question(view === 'action' ? 'Action' : view === 'reference' ? 'Reference' : 'Someday'));
    if (active.proposal.view === 'action') {
      const choices = element('fieldset', { className: 'clarify-dispositions' }), legend = element('legend', { textContent: 'Disposition' }); choices.append(legend);
      for (const [status, label] of [['next', 'Next'], ['waiting', 'Waiting'], ['planned', 'Plan'], ['deferred', 'Defer'], ['completed', 'Done']]) {
        const button = control(label, () => setStatus(status)); button.dataset.focusKey = `status:${status}`; button.setAttribute('aria-pressed', String(active.proposal.status === status)); choices.append(button);
      }
      container.append(choices);
      if (active.proposal.status === 'waiting') container.append(labeledInput('waitingOn', 'Waiting for', 'text', true), labeledInput('reviewDate', 'Follow up on (optional)', 'date'));
      if (active.proposal.status === 'planned') container.append(labeledInput('plannedDay', 'Planned day', 'date', true));
      if (active.proposal.status === 'deferred') container.append(labeledInput('startDate', 'Not before', 'date', true));
      const reminder = element('p', { className: 'muted', textContent: 'If it takes less than two minutes, do it now and choose Done only after it is finished.' }); container.append(reminder);
    } else if (active.proposal.view === 'someday') container.append(labeledInput('reviewDate', 'Reconsider on (optional)', 'date'));
    destinationSurface(container);
  }
  function drawResult() {
    const strip = $('clarifyResult'); strip.replaceChildren(); strip.hidden = !active?.previous;
    if (!active?.previous) return;
    strip.append(element('span', { textContent: active.previous.message }), control('Undo previous decision', undo));
  }
  function draw({ preserve = false, focusKey = 'heading' } = {}) {
    const panelScroll = preserve ? dialog.scrollTop : 0;
    const destinationsScroll = preserve ? form.querySelector('.clarify-destinations')?.scrollTop || 0 : 0;
    const container = $('clarifyFlow'); container.replaceChildren();
    $('clarifyError').hidden = true; $('clarifyDraftStatus').textContent = '';
    drawResult();
    if (active.finished) {
      const remaining = inboxItems();
      $('clarifyHeading').textContent = remaining.length ? 'All inbox items viewed' : 'Clarify inbox complete';
      $('clarifyProgress').textContent = `${active.processed} processed · ${active.skipped} skipped · ${Object.values(records()).filter(record => record.type === 'project' && !record.deleted && record.status === 'draft').length} project(s) need outcomes`;
      $('clarifyTitleLabel').hidden = true; $('clarifyOriginalDetails').hidden = true; $('clarifyOriginal').textContent = '';
      container.append(question('Session summary'), element('p', { id: 'clarifyHelp', textContent: remaining.length ? `${remaining.length} unprocessed item(s) remain in Inbox. Return to start another pass when you are ready.` : 'Every inbox item in this pass has been processed. Draft projects are listed as Needs outcome and included in weekly review.' }));
      if (remaining.length) container.append(control('Return to first unprocessed item', restartUnprocessed));
      $('clarifySave').hidden = true; $('clarifySkip').hidden = true; $('clarifyStop').textContent = 'Done'; $('clarifyStop').focus(); return;
    }
    const total = active.ids.length;
    $('clarifyHeading').textContent = 'Clarifying'; $('clarifyProgress').textContent = active.sessionMode ? `${active.index + 1} of ${total}` : 'One item';
    $('clarifyTitleLabel').hidden = false; $('clarifyTitle').value = active.proposal.title; $('clarifyOriginalDetails').hidden = false; $('clarifyOriginal').textContent = active.item.originalText || active.item.title;
    $('clarifySave').hidden = false; $('clarifySkip').hidden = false; $('clarifyStop').textContent = 'Stop';
    if (active.proposal.view === 'classify') drawClassify(container); else drawItemDecision(container);
    updateSaveState();
    if (preserve) {
      dialog.scrollTop = panelScroll;
      const list = form.querySelector('.clarify-destinations'); if (list) list.scrollTop = destinationsScroll;
    }
    const target = focusKey === 'heading' ? $('clarifyHeading') : [...form.querySelectorAll('[data-focus-key]')].find(control => control.dataset.focusKey === focusKey);
    target?.focus({ preventScroll: preserve });
  }
  function updateSaveState() {
    if (active.finished) return;
    const destination = selectedDestination();
    $('clarifySave').disabled = active.proposal.view === 'classify' && (!destination || !membershipChange(active.item, active.proposal.parentRef));
  }
  function makeLabel(label) {
    const parent = active.proposal.parentRef && records()[refKey(active.proposal.parentRef)];
    return parent ? `${label} under ${parent.title}` : label;
  }
  function setView(view, focusKey = 'question') { active.proposal = { ...values(), view, status: view === 'action' ? 'next' : active.proposal.status }; draw({ preserve: view === 'classify', focusKey }); void journal(); }
  function setStatus(status) { active.proposal = { ...values(), status }; draw({ preserve: true, focusKey: `status:${status}` }); void journal(); }
  function clearDestination() { active.proposal = { ...values(), mode: 'parent', parentRef: null }; draw({ preserve: true, focusKey: 'destination:none' }); void journal(); }
  function chooseDestination(destination) {
    const destinationRef = { type: destination.type, id: destination.id };
    active.proposal = { ...values(), mode: 'parent', parentRef: destinationRef };
    draw({ preserve: true, focusKey: `destination:${refKey(destinationRef)}` }); void journal();
  }
  function selectedDestination() { return active.proposal.parentRef ? records()[refKey(active.proposal.parentRef)] : null; }
  async function saveChoice() {
    const destination = selectedDestination();
    if (active.proposal.view === 'classify') { if (destination) await file(destination); return; }
    await saveItem(destination);
  }
  function clarificationMutation(item, fields) {
    const saved = records()[`clarification:${item.id}`];
    return { type: 'clarification', id: item.id, action: saved ? 'update' : 'create', expectedVersion: saved?.version || 0, fields };
  }
  function sourceMetadata(item) {
    return Object.fromEntries(['originalText', 'sourceUrl', 'sourceTitle', 'selectedText', 'captureId', 'capturedAt', 'captureTimeZone']
      .filter(name => item[name] !== undefined).map(name => [name, item[name]]));
  }
  function inboxItems() {
    return Object.values(records()).filter(record => record.type === 'item' && !record.deleted && record.status === 'inbox')
      .sort((a, b) => (a.createdUtc || '').localeCompare(b.createdUtc || '') || a.id.localeCompare(b.id));
  }
  function nextInboxIndex(start) {
    for (let index = start; index < active.ids.length; index++) {
      const candidate = records()[`item:${active.ids[index]}`];
      if (candidate?.type === 'item' && !candidate.deleted && candidate.status === 'inbox') return index;
    }
    return active.ids.length;
  }
  function nextActive(decision, message, advance, updatedItem) {
    const resuming = advance && active.resume;
    const nextIndex = resuming ? active.resume.index : advance ? nextInboxIndex(active.index + 1) : active.index;
    const nextItem = resuming ? active.resume.item : advance ? records()[`item:${active.ids[nextIndex]}`] : updatedItem;
    const common = { ids: active.ids, index: nextIndex, sessionMode: active.sessionMode, processed: active.processed + (advance ? 1 : 0), skipped: active.skipped,
      recentRefs: active.recentRefs || [], previous: { itemId: active.item.id, decision, message }, resume: null };
    return nextItem ? { ...common, item: nextItem, session: currentSession(nextItem), proposal: resuming ? active.resume.proposal : advance ? flowProposal(nextItem) : flowProposal(updatedItem), finished: false, open: true }
      : { ...common, item: null, session: null, proposal: flowProposal(), finished: true, open: true };
  }
  async function convert(kind) {
    const item = active.item, title = requireTitle(values().title), id = crypto.randomUUID(), type = kind === 'project' ? 'project' : 'list';
    const parentRef = values().parentRef || null, containerRef = { type, id }, decision = { type: 'convert', containerRef, containerKind: kind, parentRef, title };
    const fields = { title, description: item.description || '', workspaceId: item.workspaceId, parentRef, ...sourceMetadata(item),
      ...(type === 'project' ? { outcome: '', status: 'draft' } : { kind }) };
    const session = { flowVersion: 3, step: 'complete', decision, proposal: flowProposal(item) };
    const mutations = [clarificationMutation(item, session), { type, id, action: 'create', expectedVersion: 0, fields }, { type: 'item', id: item.id, action: 'delete', expectedVersion: item.version }];
    const next = nextActive(decision, `Converted to ${collectionKinds[kind]}: ${title}`, true);
    if (!await save(mutations, next)) return; active = next; draw(); announce(next.previous.message);
  }
  async function file(destination) {
    const item = active.item, proposal = values(), destinationRef = { type: destination.type, id: destination.id }, after = membershipChange(item, destinationRef);
    if (!after) { announce(`Already filed in ${destination.title}.`); return; }
    const decision = { type: 'file', destinationRef, before: beforeFields(item, after), after };
    const session = { flowVersion: 3, step: 'classify', decision, proposal: flowProposal(item) };
    const updated = { ...item, ...after, version: item.version + 1 }, next = nextActive(decision, `Filed in ${destination.title}`, false, updated);
    next.proposal = proposal;
    next.recentRefs = [refKey(destinationRef), ...(active.recentRefs || []).filter(value => value !== refKey(destinationRef))].slice(0, 5);
    if (!await save([clarificationMutation(item, session), { type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: after }], next)) return;
    active = next; draw(); announce(next.previous.message);
  }
  async function saveItem(destination) {
    const item = active.item, proposal = values(), destinationRef = destination ? { type: destination.type, id: destination.id } : null;
    const after = itemFields(item, proposal, destinationRef), decision = { type: 'item', before: beforeFields(item, after), after };
    const session = { flowVersion: 3, step: 'complete', decision, proposal: flowProposal(item) };
    const next = nextActive(decision, `Saved ${after.status}: ${after.title}`, true);
    if (destinationRef) next.recentRefs = [refKey(destinationRef), ...(active.recentRefs || []).filter(value => value !== refKey(destinationRef))].slice(0, 5);
    if (!await save([clarificationMutation(item, session), { type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: after }], next)) return;
    active = next; draw(); announce(next.previous.message);
  }
  async function trash() {
    if (!confirm(`Move “${active.item.title}” to Deleted? It can be restored.`)) return;
    const item = active.item, decision = { type: 'trash' }, session = { flowVersion: 3, step: 'complete', decision, proposal: flowProposal(item) };
    const next = nextActive(decision, `Moved to Deleted: ${item.title}`, true);
    if (!await save([clarificationMutation(item, session), { type: 'item', id: item.id, action: 'delete', expectedVersion: item.version }], next)) return;
    active = next; draw(); announce(next.previous.message);
  }
  async function undo() {
    const previous = active.previous, all = records(), item = all[`item:${previous.itemId}`], clarification = all[`clarification:${previous.itemId}`], d = previous.decision;
    if (!item || !clarification || clarification.decision?.type !== d.type) throw new Error('This decision changed and can no longer be undone.');
    const session = { flowVersion: 3, step: 'reversed', decision: d, proposal: flowProposal(item) };
    const mutations = [{ type: 'clarification', id: item.id, action: 'update', expectedVersion: clarification.version, fields: session }];
    if (d.type === 'convert') {
      const target = all[refKey(d.containerRef)];
      if (!item.deleted || !target || target.deleted || target.version !== 1) throw new Error('The created container changed and can no longer be undone safely.');
      mutations.push({ type: 'item', id: item.id, action: 'restore', expectedVersion: item.version }, { type: target.type, id: target.id, action: 'delete', expectedVersion: target.version });
    } else if (d.type === 'trash') mutations.push({ type: 'item', id: item.id, action: 'restore', expectedVersion: item.version });
    else mutations.push({ type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: d.before });
    const restored = { ...item, ...(d.before || {}), version: item.version + 1, deleted: false };
    const resume = active.item && active.item.id !== item.id ? { item: active.item, proposal: values(), index: active.index } : null;
    const next = { ...active, item: restored, index: Math.max(0, active.ids.indexOf(item.id)), finished: false, processed: Math.max(0, active.processed - (d.type === 'file' ? 0 : 1)),
      session: { ...session, version: clarification.version + 1 }, proposal: flowProposal(restored), previous: null, resume, open: true };
    if (!await save(mutations, next)) return; active = next; draw(); announce('Previous clarification decision undone.');
  }
  async function skip() {
    if (!active?.item) return;
    active = { ...nextActive(null, '', true), processed: active.processed, skipped: active.skipped + 1, previous: active.previous };
    await journal(); draw(); announce(active.finished ? inboxItems().length ? 'All inbox items viewed.' : 'Clarification session complete.' : `Skipped. ${active.item.title}`);
  }
  async function restartUnprocessed() {
    const items = inboxItems();
    if (!items.length) { active = { ...active, finished: true }; await journal(); draw(); return; }
    active = initial(items, true); await journal(); draw(); void guidance.check();
  }
  function announce(message) { $('clarifyDraftStatus').textContent = `${message} · Saved on device; sync pending.`; }
  async function perform(action) {
    if (busy || !active) return;
    guidance.hide(); busy = true; active.proposal = values();
    for (const input of form.elements) input.disabled = true;
    try { await action(); }
    catch (error) { $('clarifyError').textContent = error.message; $('clarifyError').hidden = false; }
    finally {
      busy = false;
      for (const input of form.elements) input.disabled = false;
      if (dialog.open) { updateSaveState(); void guidance.check(); }
    }
  }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', event => {
    if (!active) return;
    active.proposal = values(); guidance.invalidate();
    if (event.target.dataset.proposal === 'search') {
      draw({ preserve: true, focusKey: 'search' }); const search = form.querySelector('[data-proposal=search]'); search?.setSelectionRange(search.value.length, search.value.length);
    } else drawResult();
    void journal();
  });
  $('clarifySave').onclick = () => void perform(saveChoice);
  $('clarifySkip').onclick = () => void perform(skip);
  $('clarifyStop').onclick = () => { guidance.hide(); dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else guidance.hide(); });
  dialog.addEventListener('close', () => { guidance.hide(); if (active) { active.open = false; void journal(); } });
  window.addEventListener('pagehide', () => guidance.hide());
  document.addEventListener('visibilitychange', () => { if (document.hidden) guidance.hide(); else if (dialog.open) void guidance.check(); });

  function initial(items, sessionMode) {
    const item = items[0];
    return { item, ids: items.map(entry => entry.id), index: 0, sessionMode, processed: 0, skipped: 0, recentRefs: [], previous: null,
      session: currentSession(item), proposal: flowProposal(item), finished: false, open: true };
  }
  function begin(items, sessionMode) {
    if (!items.length) throw new Error('No unprocessed captures are available to clarify.');
    const resuming = active?.item && !active.finished && active.sessionMode === sessionMode &&
      (sessionMode ? items.some(item => item.id === active.item.id) : active.item.id === items[0].id);
    active = resuming ? { ...active, item: records()[`item:${active.item.id}`], open: true } : initial(items, sessionMode);
    showDialog(dialog); draw(); void journal(); void guidance.check();
  }
  return {
    snapshot,
    open(item) {
      const saved = records()[`clarification:${item.id}`];
      if (item.deleted && saved?.step === 'complete' && saved.decision?.type === 'convert') {
        active = { item: null, ids: [item.id], index: 1, sessionMode: false, processed: 1, skipped: 0, recentRefs: [], session: saved,
          proposal: flowProposal(item), finished: true, open: true, previous: { itemId: item.id, decision: saved.decision, message: `Converted to ${collectionKinds[saved.decision.containerKind]}: ${saved.decision.title}` } };
        showDialog(dialog); draw(); return;
      }
      begin([item], false);
    },
    openInbox() {
      begin(inboxItems(), true);
    },
    restore(saved) {
      if (!saved) return;
      const item = saved.item?.id ? records()[`item:${saved.item.id}`] || saved.item : null;
      active = { ...saved, item, proposal: { ...flowProposal(item || {}), ...saved.proposal }, open: saved.open === true };
      if (!active.finished && (!item || item.deleted)) { active = null; return; }
      if (active.open) { showDialog(dialog); draw(); void guidance.check(); }
    },
    hide() { guidance.hide(); active = null; if (dialog.open) dialog.close(); form.reset(); $('clarifyFlow').replaceChildren(); $('clarifyResult').replaceChildren(); },
    close() { guidance.hide(); if (dialog.open) dialog.close(); }
  };
}
