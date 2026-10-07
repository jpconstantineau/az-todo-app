import { collectionKinds, collectionKind, isCollection, refKey, ancestry, normalizeMembership } from './collection-model.js?v=4';

export const viewKey = record => record.type === 'project' ? refKey(record) : record.id;
export const parseRef = value => { const [type, id] = value.split(':'); return { type, id }; };
export const collectionLabel = record => collectionKind(record) === 'list' ? record.title : `${collectionKinds[collectionKind(record)]}: ${record.title}${record.type === 'project' ? ` (${record.status === 'draft' ? 'Needs outcome' : record.status === 'someday' ? 'Someday / on hold' : record.status === 'completed' ? 'Completed' : 'Active'})` : ''}`;
export function pickerOptions(control, records, refs = []) {
  const selected = refs.map(refKey), available = Object.values(records).filter(record => isCollection(record) && !record.deleted);
  control.replaceChildren(...available.map(record => new Option(ancestry(record, records).reverse().map(ref => records[refKey(ref)]?.title || 'Unavailable').join(' / ') + ` · ${collectionKinds[collectionKind(record)]}`, refKey(record))));
  for (const value of selected) if (![...control.options].some(option => option.value === value)) control.add(new Option(`Unavailable collection (${value}) — remove or restore`, value));
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
  const available = Object.values(records).filter(record => isCollection(record) && !record.deleted);
  const row = (record, seen = new Set()) => {
    const node = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.textContent = collectionLabel(record); button.dataset.focusKey = `collection:${refKey(record)}`; button.onclick = () => open(record);
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
