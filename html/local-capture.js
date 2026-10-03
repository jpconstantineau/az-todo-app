import { modelOptions, extractionSchema, extractionPrompt, parseExtraction } from './capture-extraction.js?v=26';

export function setupLocalCapture({ source, lists, journal, save }) {
  const $ = id => document.getElementById(id);
  const panel = $('localCapture'), start = $('captureSuggest'), cancel = $('captureSuggestCancel'), review = $('captureReview');
  let draft = null, generation = 0, controller, session, timeout, readiness = 'unavailable', busy = false, accepting = false;
  const message = text => { if ($('captureAIStatus').textContent !== text) $('captureAIStatus').textContent = text; };
  const destroy = model => { try { model?.destroy(); } catch { /* Cancellation may already release it. */ } };
  function stop() {
    generation++; controller?.abort(); controller = null; clearTimeout(timeout); destroy(session); session = null;
    busy = false; cancel.hidden = true;
    start.disabled = !!draft?.items || readiness === 'unavailable';
    $('captureAILists').disabled = $('captureManualReview').disabled = !!draft?.items;
  }
  function changed() {
    if (accepting) return;
    stop();
    const input = source();
    if (!input) { draft = null; return; }
    if (!draft || draft.text !== input.text || draft.notes !== input.notes) {
      draft = { id: crypto.randomUUID(), ...input, capturedUtc: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    }
    message('Your original stays in the capture box. Local AI runs only when requested.');
  }
  function render() {
    const reviewing = Array.isArray(draft?.items);
    review.hidden = !reviewing;
    $('captureText').readOnly = reviewing;
    $('capture').elements.body.readOnly = reviewing;
    $('capture').querySelector('[type=submit]').disabled = reviewing;
    $('previewSplit').disabled = reviewing;
    start.disabled = reviewing || busy || readiness === 'unavailable';
    $('captureManualReview').disabled = reviewing || busy;
    $('captureAILists').disabled = reviewing || busy;
    $('captureReviewItems').replaceChildren();
    if (!reviewing) return;
    panel.open = true;
    $('captureOriginal').textContent = draft.text + (draft.notes ? '\n\nNotes:\n' + draft.notes : '');
    $('captureMoment').textContent = `Captured ${new Date(draft.capturedUtc).toLocaleString('en', { timeZone: draft.timeZone })} · ${draft.timeZone}. Dates use this timezone.`;
    $('captureAccept').disabled = !draft.items.length || busy;
    $('captureAdd').disabled = draft.items.length >= 20 || busy;
    for (const [index, item] of draft.items.entries()) {
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend'); legend.textContent = `Suggested task ${index + 1}`; fieldset.append(legend);
      const details = document.createElement('details'), summary = document.createElement('summary'); details.append(summary);
      const summarize = () => {
        const due = item.dueDate || (item.dueDateUtc && Number.isFinite(Date.parse(item.dueDateUtc)) ? new Date(item.dueDateUtc).toLocaleString('en', { timeZone: draft.timeZone }) + ' ' + draft.timeZone : '');
        summary.textContent = ['Task details', lists().find(list => list.id === item.listId)?.title, due && `Due ${due}`, item.priority, ...item.contexts, ...item.areas].filter(Boolean).join(' · ');
      };
      summarize();
      for (const [name, title, kind, max] of [
        ['title', 'Title', 'input', 200], ['description', 'Notes', 'textarea', 4000], ['listId', 'Destination list', 'select'],
        ['dueDate', 'Deadline (calendar date)', 'date'], ['dueDateUtc', 'Deadline time (ISO with offset)', 'input', 40],
        ['priority', 'Priority', 'input', 64], ['contexts', 'Contexts (one per line)', 'textarea', 1299], ['areas', 'Areas (one per line)', 'textarea', 1299]
      ]) {
        const label = document.createElement('label'); label.textContent = title;
        const input = document.createElement(kind === 'date' ? 'input' : kind); input.name = `${item.id}-${name}`; input.dataset.field = name;
        if (kind === 'date') { input.type = 'date'; input.min = '0001-01-01'; input.max = '9999-12-31'; }
        if (max) input.maxLength = max;
        if (kind === 'textarea') input.rows = name === 'description' ? 3 : 2;
        if (kind === 'select') {
          input.append(new Option('Inbox (no list)', ''), ...lists().map(list => new Option(list.title, list.id)));
          if (item.listId && !lists().some(list => list.id === item.listId)) input.add(new Option('Unavailable list — choose another', item.listId));
        }
        input.value = Array.isArray(item[name]) ? item[name].join('\n') : item[name];
        if (name === 'title') input.required = true;
        if (name === 'dueDateUtc') input.placeholder = '2026-10-04T15:00:00-06:00';
        input.addEventListener('input', () => {
          item[name] = ['contexts', 'areas'].includes(name) ? input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : input.value;
          summarize();
          void journal();
        });
        label.append(input); (['title', 'description'].includes(name) ? fieldset : details).append(label);
      }
      fieldset.append(details);
      if (item.warning) { const warning = document.createElement('p'); warning.textContent = 'Review: ' + item.warning; fieldset.append(warning); }
      const actions = document.createElement('div'); actions.className = 'actions';
      const action = (text, run) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = run; actions.append(button); return button; };
      action('Remove suggestion', () => {
        draft.items.splice(index, 1); render(); void journal();
        ($('captureReviewItems').querySelectorAll('input')[0] || $('captureAdd')).focus();
      });
      if (index > 0) action('Merge into previous task', () => {
        const previous = draft.items[index - 1];
        const combined = [previous.description, item.title, item.description,
          JSON.stringify({ listId: item.listId, dueDate: item.dueDate, dueDateUtc: item.dueDateUtc, priority: item.priority, contexts: item.contexts, areas: item.areas }), item.warning].filter(Boolean).join('\n');
        if (combined.length > 4000) { message('Merged notes would exceed 4,000 characters. Edit the notes before merging.'); return; }
        previous.description = combined; draft.items.splice(index, 1); render(); void journal();
        $('captureReviewItems').querySelectorAll('fieldset')[index - 1].querySelector('textarea').focus();
      });
      fieldset.append(actions); $('captureReviewItems').append(fieldset);
    }
  }
  async function check() {
    const current = generation;
    start.disabled = true;
    try {
      const api = globalThis.LanguageModel;
      const available = api?.availability && api?.create ? await api.availability(modelOptions) : 'unavailable';
      if (generation !== current) return;
      readiness = ['available', 'downloadable', 'downloading'].includes(available) ? available : 'unavailable';
      start.disabled = !!draft?.items || busy || readiness === 'unavailable';
      start.textContent = readiness === 'downloadable' ? 'Download model and suggest tasks' : readiness === 'downloading' ? 'Continue download and suggest tasks' : 'Suggest tasks';
      if (!draft?.items) message(readiness === 'unavailable' ? 'Local AI is unavailable here. Save manually above: one item per line, with optional split preview.' : 'English suggestions run on this device only when requested. Review before saving.');
    } catch { if (generation === current) { readiness = 'unavailable'; start.disabled = true; message('Could not check local AI. Manual capture is available; reopen this panel to retry.'); } }
  }
  start.onclick = async () => {
    if (busy || draft?.items || start.disabled) return;
    changed();
    if (!draft?.text.trim()) { message('Enter your thoughts above first.'); return; }
    if (draft.text.length > 16000 || draft.notes.length > 4000) { message('Use at most 16,000 characters of capture text and 4,000 of notes. Your text is kept.'); return; }
    const submitted = structuredClone(draft), current = generation, destinations = $('captureAILists').checked ? lists().map(({ id, title }) => ({ id, title })) : [];
    const abort = new AbortController(); controller = abort; busy = true; start.disabled = true; cancel.hidden = false; $('captureAILists').disabled = $('captureManualReview').disabled = true;
    message('Saving the original and preparing local AI…');
    // The model is created in the click to retain user activation; no capture enters prompt() before the journal commits.
    let model;
    try {
      const modelPromise = globalThis.LanguageModel.create({ ...modelOptions, signal: abort.signal, monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => {
          if (generation === current && Number.isFinite(event.loaded)) message(`Downloading browser model: ${Math.round(Math.max(0, Math.min(1, event.loaded)) * 100)}%. Your original is kept.`);
        });
      } });
      // Attach a rejection handler immediately while local persistence is pending.
      const settledModel = Promise.resolve(modelPromise).then(value => ({ value }), error => ({ error }));
      const persisted = await journal();
      const result = await settledModel; model = result.value;
      if (result.error) throw result.error;
      if (generation !== current) return;
      if (!persisted) throw new Error('Original could not be saved on device. Copy or export it before retrying.');
      session = model;
      message('Original saved on device. Suggesting tasks…');
      timeout = setTimeout(() => { if (generation === current) { stop(); message('Local AI took too long. Your original is kept; retry or save manually.'); start.focus(); } }, 60000);
      const raw = await model.prompt(extractionPrompt(submitted, destinations), { signal: abort.signal, responseConstraint: extractionSchema });
      if (generation !== current) return;
      draft.items = parseExtraction(raw, submitted, destinations);
      render();
      const saved = await journal();
      if (generation !== current) return;
      message(saved ? draft.items.length ? 'Suggestions saved in the device draft, not accepted. Review every field before saving tasks.' : 'No tasks found. The original is kept. Add a task manually or return to the original.' : 'Suggestions are not saved on device. Copy or export before leaving.');
      $('captureReviewHeading').focus();
    } catch (failure) {
      if (generation === current) message('Local AI could not finish: ' + failure.message + ' Your original is kept; retry or save manually.');
    } finally {
      destroy(model);
      if (generation === current) { clearTimeout(timeout); session = null; controller = null; busy = false; cancel.hidden = true; render(); }
    }
  };
  cancel.onclick = () => { stop(); $('captureAILists').disabled = false; message('Local suggestion cancelled. Your original is kept.'); start.focus(); };
  $('captureManualReview').onclick = async () => {
    if (busy || draft?.items) return;
    changed();
    if (!draft?.text.trim()) { message('Enter your thoughts above first.'); return; }
    draft.items = []; render();
    $('captureAdd').click();
    message('Manual review. Add titles and notes, using the original below. No AI is needed.');
  };
  $('captureReturn').onclick = () => { stop(); if (draft) delete draft.items; render(); void journal(); message('Suggestions discarded. Your original is unchanged.'); $('captureText').focus(); };
  $('captureAdd').onclick = () => {
    if (!draft?.items || draft.items.length >= 20) return;
    draft.items.push({ id: crypto.randomUUID(), title: '', description: '', listId: '', dueDate: '', dueDateUtc: '', priority: '', contexts: [], areas: [], warning: '' });
    render(); void journal(); $('captureReviewItems').lastElementChild.querySelector('input').focus();
  };
  review.onsubmit = async event => {
    event.preventDefault(); if (busy || !draft?.items?.length) return;
    const submitted = structuredClone(draft), current = generation;
    busy = accepting = true; for (const input of review.elements) input.disabled = true;
    try {
      if (!await journal()) throw new Error('Could not save the reviewed draft on this device.');
      await save(submitted);
      if (generation !== current) return;
      draft = null; render(); message('Tasks saved on device. Server confirmation follows sync.'); $('captureText').focus();
    } catch (failure) { if (generation === current) message(failure.message + ' Your review is kept.'); }
    finally { if (generation === current) { busy = accepting = false; for (const input of review.elements) input.disabled = false; render(); } }
  };
  panel.addEventListener('toggle', () => {
    if (panel.open) { if (!busy) void check(); }
    else if (!accepting) { stop(); $('captureAILists').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && busy && !accepting) { stop(); message('Local suggestion stopped while away. Your original and review are kept.'); } });
  return {
    snapshot: () => structuredClone(draft), changed,
    restore(value) { stop(); draft = value ? structuredClone(value) : null; render(); if (draft?.items) message('Unaccepted review restored from this device. Check each task before saving.'); if (panel.open) void check(); },
    reset() { stop(); accepting = false; draft = null; for (const input of review.elements) input.disabled = false; render(); panel.open = false; $('captureOriginal').textContent = ''; $('captureMoment').textContent = ''; message(''); },
    cancel() { stop(); }
  };
}
