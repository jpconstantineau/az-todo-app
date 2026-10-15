import { collectionKinds, collectionKind, isCollection, isEffectivelyArchived, refKey, ancestry, normalizeMembership, belongsTo } from './collection-model.js?v=5';

export const viewKey = record => record.type === 'project' ? refKey(record) : record.id;
export const parseRef = value => { const [type, id] = value.split(':'); return { type, id }; };
// Current project health: membership history is not complete enough to claim "never".
export function projectHealth(project, records) {
  const tasks = Object.values(records).filter(record => record.type === 'item' && !record.deleted &&
    record.workspaceId === project.workspaceId && record.status !== 'reference' && belongsTo(record, project));
  if (!tasks.length) return { face: '😭', explanation: 'No tasks' };
  const allCompleted = tasks.every(task => task.status === 'completed');
  if (project.status === 'completed' && allCompleted) return { face: '😊', explanation: 'Project and all tasks completed' };
  if (tasks.some(task => task.status === 'next')) return { face: '😐', explanation: 'Has next actions' };
  return { face: '😞', explanation: allCompleted ? 'All tasks completed; project is not completed' : 'No next actions' };
}
export function projectName(record, records) {
  if (record.type !== 'project') return record.title;
  const { face, explanation } = projectHealth(record, records);
  return `${face} ${record.title} — ${explanation}`;
}
export const collectionLabel = (record, records) => collectionKind(record) === 'list' ? record.title : `${collectionKinds[collectionKind(record)]}: ${records ? projectName(record, records) : record.title}${record.type === 'project' ? ` (${record.status === 'draft' ? 'Needs outcome' : record.status === 'someday' ? 'Someday / on hold' : record.status === 'completed' ? 'Completed' : 'Active'})` : ''}`;
export const collectionPath = (record, records) => ancestry(record, records).reverse().map(ref => records[refKey(ref)] ? projectName(records[refKey(ref)], records) : 'Unavailable').join(' / ');
export function pickerOptions(control, records, refs = []) {
  const selected = refs.map(refKey), available = Object.values(records).filter(record => isCollection(record) && !record.deleted && !isEffectivelyArchived(record, records));
  control.replaceChildren(...available.map(record => new Option(collectionPath(record, records) + ` · ${collectionKinds[collectionKind(record)]}`, refKey(record))));
  for (const value of selected) if (![...control.options].some(option => option.value === value)) control.add(new Option(`${records[value] && isEffectivelyArchived(records[value], records) ? 'Archived collection' : 'Unavailable collection'} (${value}) — keep or remove`, value));
  for (const option of control.options) option.selected = selected.includes(option.value);
}
export function organizer(container, records, refs, name = 'collectionRefs') {
  const label = document.createElement('label'), select = document.createElement('select');
  label.textContent = 'Organize in…'; select.name = name; select.multiple = true; select.size = 5;
  pickerOptions(select, records, refs); label.append(select); container.append(label);
  const help = document.createElement('p'); help.className = 'muted'; help.textContent = 'Choose any combination, or none. Membership does not change workflow. Parent lists include nested items without adding another membership. On desktop, use Ctrl/Command or Shift to select several.'; container.append(help);
  return select;
}
export const selectedRefs = control => [...control.selectedOptions].map(option => parseRef(option.value));
export function membershipFields(refs, old = {}) {
  const record = normalizeMembership({ ...old }, old, { collectionRefs: refs });
  return { collectionRefs: record.collectionRefs, listId: record.listId || null, projectId: record.projectId || null };
}
export function drawOutline(container, records, open) {
  const expanded = new Set([...container.querySelectorAll('details[open]')].map(node => node.dataset.ref));
  const available = Object.values(records).filter(record => isCollection(record) && !record.deleted && !isEffectivelyArchived(record, records));
  const row = (record, seen = new Set()) => {
    const node = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.textContent = collectionLabel(record, records); if (record.type === 'project') button.title = button.textContent;
    button.dataset.focusKey = `collection:${refKey(record)}`; button.onclick = () => open(record);
    const children = available.filter(child => child.parentRef && refKey(child.parentRef) === refKey(record) && !seen.has(refKey(child)));
    if (children.length) {
      const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul');
      details.dataset.ref = refKey(record); details.open = expanded.has(refKey(record)); summary.textContent = `Children of ${record.title}`;
      list.append(...children.map(child => row(child, new Set([...seen, refKey(record)])))); details.append(summary, list); node.append(button, details);
    } else node.append(button);
    return node;
  };
  const list = document.createElement('ul');
  list.append(...available.filter(record => !record.parentRef || !records[refKey(record.parentRef)] || records[refKey(record.parentRef)].deleted).map(record => row(record)));
  container.replaceChildren(list);
}
