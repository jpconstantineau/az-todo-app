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

export function setupPlan({ records, navigation, readOnly, save, edit, inspectDeleted, openCollection, openProcess, journal }) {
  const choose = focus => {
    navigation().focus = focus;
    render(); void journal();
  };
  $('planFocus').addEventListener('change', () => choose($('planFocus').value));
  $('planWeek').addEventListener('change', () => {
    navigation().week = $('planWeek').value || localMonday();
    render(); void journal();
  });
  $('planDay').addEventListener('change', () => { openProcess('set-day', $('planDay').value); render(); void journal(); });
  $('planOpenDay').addEventListener('click', () => openProcess('open-day', $('planDay').value));

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

    const day = $('planDay').value;
    const dayItems = all.filter(record => record.type === 'item' && !record.deleted && day && record.plannedDay === day);
    $('planDayActions').replaceChildren(...dayItems.map(item => {
      const article = document.createElement('article'); article.className = 'plan-day-action'; article.dataset.id = item.id;
      const editButton = control(item.title, () => edit(item), `Edit ${item.title}`, `plan:day:${item.id}`); editButton.disabled = readOnly(); article.append(editButton);
      const paths = document.createElement('span'); paths.className = 'muted'; paths.textContent = membershipPaths(item, recordMap).join(' · ') || 'No collection'; article.append(paths);
      return article;
    }));
    if (!$('planDayActions').childElementCount) $('planDayActions').textContent = day ? 'Nothing is planned for this day.' : 'Choose a day to see its planned actions.';
    $('planStatus').textContent = readOnly() ? 'This workspace is read-only. You can inspect its plan, but weekly selections are disabled.' : navigator.onLine ? '' : 'Working offline. Weekly changes stay on this device until you reconnect.';
  }

  return { render };
}
