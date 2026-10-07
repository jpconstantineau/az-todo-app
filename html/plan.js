import { ancestry, collectionKind, collectionKinds, isCollection, memberships, refKey } from './collection-model.js?v=2';

const $ = id => document.getElementById(id);
const dateText = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !value.startsWith('0000') &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function localMonday(now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return dateText(monday);
}

export function planningPath(record, records) {
  return ancestry(record, records).reverse().map(ref => records[refKey(ref)]?.title || `Unavailable ${ref.type}`).join(' / ');
}

export function membershipPaths(item, records) {
  return memberships(item).map(ref => records[refKey(ref)] ? planningPath(records[refKey(ref)], records) : `Unavailable collection (${refKey(ref)})`);
}

export function inPlanningFocus(item, focus, records) {
  return !focus || memberships(item).some(ref => refKey(ref) === focus || ancestry(ref, records).some(parent => refKey(parent) === focus));
}

export function resolvePlanningFocus(focus, records) {
  let record = records[focus], seen = new Set();
  while (record && (!isCollection(record) || record.deleted)) {
    if (!record.parentRef || seen.has(refKey(record.parentRef))) return '';
    seen.add(refKey(record.parentRef));
    record = records[refKey(record.parentRef)];
  }
  return record && isCollection(record) ? refKey(record) : '';
}

function control(text, handler, label = text, focusKey = '') {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', label);
  if (focusKey) button.dataset.focusKey = focusKey;
  button.addEventListener('click', handler);
  return button;
}

function collectionInFocus(record, focus, records) {
  return !focus || refKey(record) === focus || ancestry(record, records).some(parent => refKey(parent) === focus);
}

function collectionTree(collections, records, focus, choose) {
  const expanded = new Set([...$('planHierarchy').querySelectorAll('details[open]')].map(node => node.dataset.ref));
  const row = (record, seen = new Set()) => {
    const item = document.createElement('li');
    const open = control(`${collectionKinds[collectionKind(record)]}: ${record.title}`, () => choose(refKey(record)),
      `Plan ${record.title}`, `plan:collection:${refKey(record)}`);
    open.setAttribute('aria-pressed', String(refKey(record) === focus));
    const children = collections.filter(child => child.parentRef && refKey(child.parentRef) === refKey(record) && !seen.has(refKey(child)));
    item.append(open);
    if (children.length) {
      const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul');
      details.dataset.ref = refKey(record); details.open = expanded.has(refKey(record));
      summary.textContent = `Children of ${record.title}`;
      summary.dataset.focusKey = `plan:children:${refKey(record)}`;
      list.append(...children.map(child => row(child, new Set([...seen, refKey(record)]))));
      details.append(summary, list); item.append(details);
    }
    return item;
  };
  const list = document.createElement('ul');
  list.append(...collections.filter(record => !record.parentRef || !records[refKey(record.parentRef)] || records[refKey(record.parentRef)].deleted).map(record => row(record)));
  return list;
}

function renderBreadcrumbs(focus, records, choose) {
  const list = document.createElement('ol'), workspace = document.createElement('li');
  workspace.append(control('Workspace', () => choose(''), 'Plan the whole workspace', 'plan:breadcrumb:workspace')); list.append(workspace);
  if (focus) {
    const chain = ancestry(records[focus], records).reverse();
    for (const ref of chain) {
      const item = document.createElement('li'), record = records[refKey(ref)];
      if (record && !record.deleted) item.append(control(record.title, () => choose(refKey(record)), `Plan ${record.title}`, `plan:breadcrumb:${refKey(record)}`));
      else item.textContent = `Unavailable parent (${refKey(ref)})`;
      list.append(item);
    }
  }
  $('planBreadcrumbs').replaceChildren(list);
}

function itemRow(item, week, records, selected, readOnly, save, inspect) {
  const article = document.createElement('article'); article.className = 'plan-action'; article.dataset.id = item.id;
  const label = document.createElement('label'); label.className = 'plan-action-check';
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected;
  checkbox.disabled = readOnly || item.deleted;
  checkbox.setAttribute('aria-label', `${selected ? 'Remove' : 'Plan'} ${item.title} ${selected ? 'from' : 'for'} this week`);
  checkbox.dataset.focusKey = `plan:item:${item.id}:week`;
  const content = document.createElement('span'), title = document.createElement('strong'), details = document.createElement('span');
  title.textContent = item.title;
  const paths = membershipPaths(item, records);
  details.className = 'muted'; details.textContent = [item.deleted ? 'Deleted' : item.status, ...paths].filter(Boolean).join(' · ') || 'No collection';
  content.append(title, details); label.append(checkbox, content); article.append(label);
  if (inspect) {
    const inspectButton = control(item.deleted ? 'Inspect deleted' : 'Edit', () => inspect(item),
      `${item.deleted ? 'Inspect deleted record' : 'Edit'} ${item.title}`, `plan:item:${item.id}:inspect`);
    inspectButton.disabled = readOnly && !item.deleted; article.append(inspectButton);
  }
  checkbox.addEventListener('change', async () => {
    if (checkbox.dataset.saving) { checkbox.checked = !checkbox.checked; return; }
    checkbox.dataset.saving = 'true'; checkbox.setAttribute('aria-disabled', 'true');
    try { await save(item, { plannedWeek: checkbox.checked ? week : null }); }
    finally { if (checkbox.isConnected) { delete checkbox.dataset.saving; checkbox.removeAttribute('aria-disabled'); } }
  });
  return article;
}

export const dailyPlanId = (workspaceId, day) => `${workspaceId}_${day}`;
const planKey = (workspaceId, day) => `dailyPlan:${dailyPlanId(workspaceId, day)}`;
const assessmentLabels = { needs_assessment: 'Needs assessment', needs_reassessment: 'Needs reassessment', fits: 'Fits with room', full: 'Full', overcommitted: 'Overcommitted' };
const estimateOptions = {
  tshirt: [['', 'Unestimated'], ['XS', 'XS'], ['S', 'S'], ['M', 'M'], ['L', 'L'], ['XL', 'XL']],
  fibonacci: [['', 'Unestimated'], ['1', '1'], ['2', '2'], ['3', '3'], ['5', '5'], ['8', '8'], ['13', '13']]
};

export function orderedDayItems(recordMap, workspaceId, day) {
  const saved = recordMap[planKey(workspaceId, day)]?.actionIds || [];
  const members = Object.values(recordMap).filter(record => record.type === 'item' && !record.deleted && record.workspaceId === workspaceId && record.plannedDay === day);
  const byId = new Map(members.map(item => [item.id, item]));
  const ordered = saved.flatMap(id => byId.has(id) ? [byId.get(id)] : []);
  const included = new Set(ordered.map(item => item.id));
  return [...ordered, ...members.filter(item => !included.has(item.id)).sort((a, b) => (a.createdUtc || '').localeCompare(b.createdUtc || '') || a.id.localeCompare(b.id))];
}

export function estimateSummary(items, method) {
  if (method === 'none') return '';
  let unknown = 0, previous = 0;
  const current = items.flatMap(item => {
    if (!item.effortEstimate) { unknown++; return []; }
    if (item.effortEstimate.scale !== method) { previous++; return []; }
    return [item.effortEstimate.value];
  });
  if (method === 'fibonacci') return `${current.reduce((sum, value) => sum + value, 0)} points · ${unknown} unestimated · ${previous} previous-scale`;
  const counts = ['XL', 'L', 'M', 'S', 'XS'].flatMap(value => {
    const count = current.filter(entry => entry === value).length;
    return count ? [`${count} ${value}`] : [];
  });
  return `${counts.join(' · ') || 'No current-scale estimates'} · ${unknown} unestimated · ${previous} previous-scale`;
}

const planSnapshot = plan => ({ actionIds: [...(plan?.actionIds || [])], loadAssessment: plan?.loadAssessment || 'needs_assessment' });
const taggedEstimates = (ids, recordMap) => ids.map(actionId => ({ actionId, estimate: recordMap[`item:${actionId}`]?.effortEstimate || null }));

function planMutations(recordMap, workspaceId, day, changes, operationKind, carryoverDecision = null) {
  const existing = recordMap[planKey(workspaceId, day)], before = planSnapshot(existing), revisionId = crypto.randomUUID();
  const after = { actionIds: changes.actionIds ?? before.actionIds, loadAssessment: changes.loadAssessment ?? before.loadAssessment };
  const carryoverDecisions = changes.carryoverDecisions ?? existing?.carryoverDecisions ?? [];
  const plan = { type: 'dailyPlan', id: dailyPlanId(workspaceId, day), action: existing ? 'update' : 'create', expectedVersion: existing?.version || 0,
    fields: { ...(existing ? {} : { workspaceId, planDay: day }), actionIds: after.actionIds, loadAssessment: after.loadAssessment,
      carryoverDecisions, revisionHead: revisionId, revisionCount: (existing?.revisionCount || 0) + 1 } };
  const revision = { type: 'dailyPlanRevision', id: revisionId, action: 'create', expectedVersion: 0,
    fields: { workspaceId, planId: plan.id, planDay: day, sequence: plan.fields.revisionCount, operationKind, before, after, carryoverDecision,
      estimates: taggedEstimates(after.actionIds, recordMap) } };
  return [plan, revision];
}

export function membershipPlanMutations(recordMap, workspaceId, item, nextDay) {
  if (item.plannedDay === nextDay) return [];
  const reset = value => ['fits', 'full', 'overcommitted'].includes(value) ? 'needs_reassessment' : value;
  const mutations = [];
  if (item.plannedDay) {
    const source = recordMap[planKey(workspaceId, item.plannedDay)];
    mutations.push(...planMutations(recordMap, workspaceId, item.plannedDay, {
      actionIds: orderedDayItems(recordMap, workspaceId, item.plannedDay).filter(entry => entry.id !== item.id).map(entry => entry.id),
      loadAssessment: reset(source?.loadAssessment || 'needs_assessment')
    }, 'remove'));
  }
  if (nextDay) {
    const target = recordMap[planKey(workspaceId, nextDay)], ids = orderedDayItems(recordMap, workspaceId, nextDay).map(entry => entry.id);
    if (!ids.includes(item.id)) ids.push(item.id);
    mutations.push(...planMutations(recordMap, workspaceId, nextDay, { actionIds: ids, loadAssessment: reset(target?.loadAssessment || 'needs_assessment') }, 'add'));
  }
  return mutations;
}

const moveDay = (day, offset) => {
  const date = new Date(`${day}T12:00:00`); date.setDate(date.getDate() + offset); return dateText(date);
};

function dayDetails(item) {
  const deadline = item.dueDate || item.dueDateUtc;
  return [item.status, item.priority ? `Priority ${item.priority}` : 'No permanent priority', deadline ? `Deadline ${deadline}` : 'No deadline'].join(' · ');
}

export function setupPlan({ records, workspaceId, navigation, readOnly, save, savePlan, edit, inspectDeleted, openCollection, openProcess, journal }) {
  let lastDayAnnouncement = '';
  const choose = focus => {
    navigation().focus = focus;
    render(); void journal();
  };
  $('planFocus').addEventListener('change', () => choose($('planFocus').value));
  $('planWeek').addEventListener('change', () => {
    navigation().week = $('planWeek').value || localMonday();
    render(); void journal();
  });
  const selectDay = day => {
    if (!validDay(day)) return;
    $('planDay').value = day; openProcess('set-day', day); render(); void journal();
  };
  $('planDay').addEventListener('change', () => selectDay($('planDay').value));
  $('planPreviousDay').addEventListener('click', () => selectDay(moveDay($('planDay').value, -1)));
  $('planNextDay').addEventListener('click', () => selectDay(moveDay($('planDay').value, 1)));
  $('planCurrentDay').addEventListener('click', () => selectDay(dateText(new Date())));
  $('planOpenDay').addEventListener('click', () => openProcess('open-day', $('planDay').value));
  $('planExistingPicker').addEventListener('toggle', () => { navigation().addOpen = $('planExistingPicker').open; void journal(); });
  $('planCarryover').addEventListener('toggle', () => { navigation().carryoverOpen = $('planCarryover').open; void journal(); });
  $('planEstimationMethod').addEventListener('change', async () => {
    const map = records(), owner = workspaceId(), current = map[`planPreference:${owner}`], method = $('planEstimationMethod').value;
    await savePlan([{ type: 'planPreference', id: owner, action: current ? 'update' : 'create', expectedVersion: current?.version || 0,
      fields: { ...(current ? {} : { workspaceId: owner }), estimationMethod: method } }]);
  });
  $('planLoadAssessment').addEventListener('change', async () => {
    const map = records(), owner = workspaceId(), day = $('planDay').value, items = orderedDayItems(map, owner, day);
    await savePlan(planMutations(map, owner, day, { actionIds: items.map(item => item.id), loadAssessment: $('planLoadAssessment').value }, 'assessment'));
  });
  $('planQuickAdd').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, title = form.elements.title.value.trim();
    if (!title || title.length > 200) return;
    const map = records(), owner = workspaceId(), day = $('planDay').value, id = crypto.randomUUID();
    const ids = [...orderedDayItems(map, owner, day).map(item => item.id), id];
    const currentAssessment = map[planKey(owner, day)]?.loadAssessment || 'needs_assessment';
    const nextAssessment = ['fits', 'full', 'overcommitted'].includes(currentAssessment) ? 'needs_reassessment' : currentAssessment;
    const item = { type: 'item', id, action: 'create', expectedVersion: 0, fields: { title, workspaceId: owner, collectionRefs: [], plannedDay: day, status: 'inbox' } };
    const saved = await savePlan([item, ...planMutations({ ...map, [`item:${id}`]: { ...item.fields, type: 'item', id } }, owner, day, { actionIds: ids, loadAssessment: nextAssessment }, 'quick_add')]);
    if (saved && form.isConnected) { form.reset(); $('planAddHeading').focus(); }
  });

  function render() {
    const recordMap = records(), all = Object.values(recordMap);
    const collections = all.filter(record => isCollection(record) && !record.deleted);
    const plan = navigation();
    plan.focus = resolvePlanningFocus(typeof plan.focus === 'string' ? plan.focus : '', recordMap);
    plan.week = validDay(plan.week) ? plan.week : localMonday();
    const focusRecord = plan.focus ? recordMap[plan.focus] : null;
    const chooseOptions = [{ value: '', text: 'Whole workspace' }, ...collections.map(record => ({ value: refKey(record), text: `${planningPath(record, recordMap)} · ${collectionKinds[collectionKind(record)]}` }))];
    $('planFocus').replaceChildren(...chooseOptions.map(entry => new Option(entry.text, entry.value)));
    $('planFocus').value = plan.focus;
    $('planHierarchy').replaceChildren(collectionTree(collections, recordMap, plan.focus, choose));
    $('planHierarchy').hidden = !collections.length;
    $('planFocusPicker').hidden = !collections.length;
    renderBreadcrumbs(plan.focus, recordMap, choose);

    const directChildren = focusRecord ? collections.filter(record => record.parentRef && refKey(record.parentRef) === plan.focus) : collections.filter(record => !record.parentRef || !recordMap[refKey(record.parentRef)] || recordMap[refKey(record.parentRef)].deleted);
    const activeProjects = collections.filter(record => record.type === 'project' && record.status === 'active' && collectionInFocus(record, plan.focus, recordMap));
    const next = all.filter(record => record.type === 'item' && !record.deleted && record.status === 'next' && inPlanningFocus(record, plan.focus, recordMap));
    const projectsWithNext = activeProjects.filter(project => next.some(item => inPlanningFocus(item, refKey(project), recordMap))).length;
    $('planFocusTitle').textContent = focusRecord?.title || 'Whole workspace';
    $('planFocusKind').textContent = focusRecord ? collectionKinds[collectionKind(focusRecord)] : 'Workspace';
    $('planFocusDescription').textContent = focusRecord ? focusRecord.outcome || focusRecord.description || 'No outcome or notes yet.' :
      collections.length ? 'Choose a role, area, initiative, project or list to narrow the plan.' : 'Start with what matters. Add a collection, or plan unfiled Next actions here.';
    const coverage = focusRecord?.type === 'project'
      ? `${next.length} Next ${next.length === 1 ? 'action' : 'actions'}`
      : `${projectsWithNext} of ${activeProjects.length} active ${activeProjects.length === 1 ? 'project has' : 'projects have'} a Next action`;
    $('planFocusCounts').textContent = `${directChildren.length} direct ${directChildren.length === 1 ? 'child' : 'children'} · ${activeProjects.length} active ${activeProjects.length === 1 ? 'project' : 'projects'} · ${coverage}`;
    const summaryActions = [];
    if (focusRecord) {
      summaryActions.push(control('Open in List Workspace', () => openCollection(focusRecord), `Open ${focusRecord.title} in List Workspace`, `plan:collection:${plan.focus}:open`));
      const editButton = control('Edit', () => edit(focusRecord), `Edit ${focusRecord.title}`, `plan:collection:${plan.focus}:edit`); editButton.disabled = readOnly(); summaryActions.push(editButton);
    } else {
      summaryActions.push(control('Open List Workspace', () => openCollection(null), 'Open List Workspace', 'plan:workspace:open'),
        control('Process inbox', () => openProcess('inbox'), 'Process inbox', 'plan:workspace:process'));
    }
    $('planFocusActions').replaceChildren(...summaryActions);

    $('planWeek').value = plan.week;
    const eligible = new Map(next.map(item => [item.id, item]));
    const selected = all.filter(record => record.type === 'item' && record.plannedWeek === plan.week && inPlanningFocus(record, plan.focus, recordMap));
    const attention = selected.filter(record => record.deleted || record.status !== 'next');
    $('planWeekActions').replaceChildren(...[...eligible.values()].map(item => itemRow(item, plan.week, recordMap, item.plannedWeek === plan.week, readOnly(), save, edit)));
    if (!$('planWeekActions').childElementCount) $('planWeekActions').textContent = next.length ? 'No actions are available for this week.' : 'No Next actions in this planning focus. Process the inbox or choose another focus.';
    $('planAttention').hidden = !attention.length;
    $('planAttentionActions').replaceChildren(...attention.map(item => itemRow(item, plan.week, recordMap, true, readOnly(), save, item.deleted ? inspectDeleted : edit)));
    const plannedReady = selected.filter(item => !item.deleted && item.status === 'next');
    const branches = (focusRecord ? directChildren : collections.filter(record => !record.parentRef || !recordMap[refKey(record.parentRef)] || recordMap[refKey(record.parentRef)].deleted))
      .map(branch => [branch.title, plannedReady.filter(item => inPlanningFocus(item, refKey(branch), recordMap)).length]).filter(([, count]) => count);
    const direct = plannedReady.filter(item => focusRecord
      ? memberships(item).some(ref => refKey(ref) === plan.focus)
      : !memberships(item).length).length;
    $('planBalance').textContent = `${plannedReady.length} unique ${plannedReady.length === 1 ? 'action' : 'actions'} planned${branches.length ? ` · ${branches.map(([title, count]) => `${title}: ${count}`).join(' · ')} (branches may overlap)` : ''}${direct ? ` · ${focusRecord ? 'Direct' : 'Unfiled'}: ${direct}` : ''}.`;

    const day = $('planDay').value, owner = workspaceId();
    const dayPlan = recordMap[planKey(owner, day)], dayItems = orderedDayItems(recordMap, owner, day);
    const preference = recordMap[`planPreference:${owner}`], method = preference?.estimationMethod || 'none';
    const assessment = dayPlan?.loadAssessment || 'needs_assessment';
    const resetAssessment = value => ['fits', 'full', 'overcommitted'].includes(value) ? 'needs_reassessment' : value;
    $('planEstimationMethod').value = method;
    $('planLoadAssessment').value = assessment;
    $('planLoadAssessment').disabled = readOnly(); $('planEstimationMethod').disabled = readOnly();
    const summary = estimateSummary(dayItems, method);
    $('planLoadSummary').textContent = `${assessmentLabels[assessment]}${summary ? ` · ${summary}` : ''}`;
    $('planLoadSummary').dataset.assessment = assessment;
    $('planExistingPicker').open = navigation().addOpen === true;

    const reorder = async (item, position) => {
      const ids = dayItems.map(entry => entry.id), from = ids.indexOf(item.id);
      const to = Math.max(0, Math.min(ids.length - 1, position));
      if (from === to) return;
      ids.splice(from, 1); ids.splice(to, 0, item.id);
      await savePlan(planMutations(recordMap, owner, day, { actionIds: ids }, 'reorder'));
    };
    const rows = dayItems.map((item, index) => {
      const row = document.createElement('li'); row.className = 'day-plan-row'; row.dataset.id = item.id;
      row.setAttribute('aria-label', `Position ${index + 1} of ${dayItems.length}: ${item.title}`);
      const content = document.createElement('div'); content.className = 'day-plan-content';
      const title = control(item.title, () => edit(item), `Edit ${item.title}`, `plan:day:${item.id}:edit`); title.disabled = readOnly();
      const meta = document.createElement('span'); meta.className = 'day-plan-meta';
      const estimate = item.effortEstimate ? item.effortEstimate.scale === method ? `${item.effortEstimate.value} ${method === 'fibonacci' ? 'points' : ''}`.trim() : `${item.effortEstimate.value} (${item.effortEstimate.scale}, previous scale)` : 'Unestimated';
      meta.textContent = `${dayDetails(item)}${method === 'none' ? '' : ` · ${estimate}`}`;
      content.append(title, meta);
      const controls = document.createElement('div'); controls.className = 'day-plan-controls'; controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', `Order and plan controls for ${item.title}, position ${index + 1}`);
      const up = control('Move up', () => reorder(item, index - 1), `Move ${item.title} up from position ${index + 1}`, `plan:day:${item.id}:up`);
      const down = control('Move down', () => reorder(item, index + 1), `Move ${item.title} down from position ${index + 1}`, `plan:day:${item.id}:down`);
      up.dataset.focusFallback = down.dataset.focusKey; down.dataset.focusFallback = up.dataset.focusKey;
      up.disabled = readOnly() || index === 0; down.disabled = readOnly() || index === dayItems.length - 1;
      const positionLabel = document.createElement('label'); positionLabel.append(document.createTextNode('Position '));
      const position = document.createElement('input'); position.type = 'number'; position.min = '1'; position.max = String(dayItems.length); position.value = String(index + 1); position.disabled = readOnly();
      position.setAttribute('aria-label', `Move ${item.title} to position`); position.dataset.focusKey = `plan:day:${item.id}:position`;
      position.addEventListener('change', () => reorder(item, Number(position.value) - 1)); positionLabel.append(position);
      controls.append(up, down, positionLabel);
      if (method !== 'none') {
        const estimateLabel = document.createElement('label'); estimateLabel.append(document.createTextNode('Estimate '));
        const select = document.createElement('select'); select.setAttribute('aria-label', `Estimate ${item.title} using ${method === 'tshirt' ? 'T-shirt' : 'Fibonacci'}`); select.disabled = readOnly();
        select.dataset.focusKey = `plan:day:${item.id}:estimate`;
        select.replaceChildren(...estimateOptions[method].map(([value, text]) => new Option(text, value)));
        select.value = item.effortEstimate?.scale === method ? String(item.effortEstimate.value) : '';
        select.addEventListener('change', async () => {
          const value = select.value ? { scale: method, value: method === 'fibonacci' ? Number(select.value) : select.value } : null;
          const ids = dayItems.map(entry => entry.id), nextMap = { ...recordMap, [`item:${item.id}`]: { ...item, effortEstimate: value } };
          await savePlan([{ type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: { effortEstimate: value } },
            ...planMutations(nextMap, owner, day, { actionIds: ids, loadAssessment: resetAssessment(assessment) }, 'estimate')]);
        });
        estimateLabel.append(select); controls.append(estimateLabel);
      }
      const remove = control('Remove', async () => {
        const ids = dayItems.filter(entry => entry.id !== item.id).map(entry => entry.id);
        await savePlan([{ type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: { plannedDay: null } },
          ...planMutations(recordMap, owner, day, { actionIds: ids, loadAssessment: resetAssessment(assessment) }, 'remove')]);
      }, `Remove ${item.title} from daily plan; keep its workflow state`, `plan:day:${item.id}:remove`);
      remove.dataset.focusFallback = dayItems[index + 1] ? `plan:day:${dayItems[index + 1].id}:edit` : dayItems[index - 1] ? `plan:day:${dayItems[index - 1].id}:edit` : 'plan:day:heading';
      remove.disabled = readOnly(); controls.append(remove); row.append(content, controls); return row;
    });
    $('planDayActions').replaceChildren(...rows);
    if (!rows.length) {
      const empty = document.createElement('li'); empty.textContent = day ? 'Nothing is planned for this day.' : 'Choose a day to build its plan.'; $('planDayActions').append(empty);
    }

    const excluded = new Set(['completed', 'dropped', 'reference']);
    const dayEligible = all.filter(item => item.type === 'item' && !item.deleted && item.workspaceId === owner && item.plannedDay !== day && !excluded.has(item.status));
    $('planEligibleActions').replaceChildren(...dayEligible.map(item => {
      const add = control(`Add ${item.title}`, async () => {
        const ids = [...dayItems.map(entry => entry.id), item.id], mutations = [{ type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: { plannedDay: day } }];
        if (item.plannedDay) {
          const sourceItems = orderedDayItems(recordMap, owner, item.plannedDay).filter(entry => entry.id !== item.id);
          const source = recordMap[planKey(owner, item.plannedDay)];
          mutations.push(...planMutations(recordMap, owner, item.plannedDay, { actionIds: sourceItems.map(entry => entry.id), loadAssessment: resetAssessment(source?.loadAssessment || 'needs_assessment') }, 'remove'));
        }
        mutations.push(...planMutations(recordMap, owner, day, { actionIds: ids, loadAssessment: resetAssessment(assessment) }, 'add'));
        await savePlan(mutations);
      }, `Add ${item.title} to ${day}`, `plan:add:${item.id}`);
      add.disabled = readOnly(); return add;
    }));
    if (!dayEligible.length) $('planEligibleActions').textContent = 'No eligible actions. Completed, dropped and Reference items are excluded.';
    $('planQuickAdd').querySelectorAll('input, button').forEach(control => { control.disabled = readOnly(); });

    const decided = new Set((dayPlan?.carryoverDecisions || []).map(entry => `${entry.sourceDay}:${entry.actionId}`));
    const carryover = all.filter(item => item.type === 'item' && !item.deleted && item.workspaceId === owner && item.plannedDay && item.plannedDay < day && !excluded.has(item.status) && !decided.has(`${item.plannedDay}:${item.id}`));
    $('planCarryover').hidden = !carryover.length; $('planCarryover').open = carryover.length && navigation().carryoverOpen !== false;
    $('planCarryoverActions').replaceChildren(...carryover.map(item => {
      const article = document.createElement('article'), heading = document.createElement('strong'), actions = document.createElement('div'); actions.className = 'actions';
      heading.textContent = `${item.title} · planned ${item.plannedDay}`;
      const decide = choice => async () => {
        const decision = { actionId: item.id, sourceDay: item.plannedDay, choice };
        const decisions = [...(dayPlan?.carryoverDecisions || []), decision], mutations = [];
        if (choice !== 'keep') {
          const sourcePlan = recordMap[planKey(owner, item.plannedDay)], sourceIds = orderedDayItems(recordMap, owner, item.plannedDay).filter(entry => entry.id !== item.id).map(entry => entry.id);
          mutations.push({ type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: { plannedDay: choice === 'move' ? day : null } },
            ...planMutations(recordMap, owner, item.plannedDay, { actionIds: sourceIds, loadAssessment: resetAssessment(sourcePlan?.loadAssessment || 'needs_assessment') }, `carryover_${choice}`, decision));
        }
        const targetIds = choice === 'move' ? [...dayItems.map(entry => entry.id), item.id] : dayItems.map(entry => entry.id);
        mutations.push(...planMutations(recordMap, owner, day, { actionIds: targetIds, carryoverDecisions: decisions, loadAssessment: choice === 'move' ? resetAssessment(assessment) : assessment }, `carryover_${choice}`, decision));
        await savePlan(mutations);
      };
      for (const [choice, label] of [['keep', 'Keep on prior date'], ['move', 'Move to selected date'], ['remove', 'Remove from daily plan']]) {
        const button = control(label, decide(choice), `${label}: ${item.title}`, `plan:carryover:${item.id}:${choice}`); button.disabled = readOnly(); actions.append(button);
      }
      article.append(heading, actions); return article;
    }));

    const history = all.filter(record => record.type === 'dailyPlanRevision' && record.planId === dailyPlanId(owner, day)).sort((a, b) => b.sequence - a.sequence);
    $('planHistoryEntries').replaceChildren(...history.map(revision => {
      const item = document.createElement('li');
      item.textContent = `${revision.sequence}. ${revision.operationKind.replaceAll('_', ' ')}: ${revision.before.actionIds.length} → ${revision.after.actionIds.length} actions; ${assessmentLabels[revision.before.loadAssessment]} → ${assessmentLabels[revision.after.loadAssessment]}`;
      return item;
    }));
    if (!history.length) $('planHistoryEntries').textContent = 'No explicit planning changes yet. Legacy Planned day actions remain available above.';
    const announcement = `${day}: ${dayItems.length} planned ${dayItems.length === 1 ? 'action' : 'actions'}. ${$('planLoadSummary').textContent}`;
    if (announcement !== lastDayAnnouncement) { $('planDayAnnouncement').textContent = announcement; lastDayAnnouncement = announcement; }
    $('planStatus').textContent = readOnly() ? 'This workspace is read-only. You can inspect its plan and history, but changes are disabled.' : navigator.onLine ? '' : 'Working offline. Plan changes stay on this device until you reconnect.';
  }

  return { render };
}
