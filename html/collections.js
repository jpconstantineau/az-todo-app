import { collectionKinds, collectionKind, isCollection, refKey, memberships, ancestry, normalizeMembership, belongsTo } from './collection-model.js?v=1';

export const viewKey = record => record.type === 'project' ? refKey(record) : record.id;
export const parseRef = value => { const [type, id] = value.split(':'); return { type, id }; };
export const collectionLabel = record => collectionKind(record) === 'list' ? record.title : `${collectionKinds[collectionKind(record)]}: ${record.title}${record.type === 'project' ? ` (${record.status === 'someday' ? 'Someday / on hold' : record.status === 'completed' ? 'Completed' : 'Active'})` : ''}`;
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
export function checklistMutations(source, items, title, next = false) {
  if (collectionKind(source) !== 'reference' || source.deleted) throw new Error('Choose a live reference list.');
  if (!title.trim() || title.length > 200) throw new Error('Name the new checklist (1–200 characters).');
  if (!items.length || items.length > 19 || new Set(items.map(item => item.id)).size !== items.length) throw new Error('Choose 1–19 entries for one checklist.');
  const id = crypto.randomUUID(), workspaceId = source.workspaceId || 'personal', destination = { type: 'list', id };
  return [{ type: 'list', id, action: 'create', expectedVersion: 0, fields: { title, kind: 'checklist', workspaceId, parentRef: source.parentRef || null } }, ...items.map(item => {
    if (item.deleted || !belongsTo(item, source)) throw new Error('A selected source entry changed. Choose the entries again.');
    return { type: 'item', id: crypto.randomUUID(), action: 'create', expectedVersion: 0, fields: { title: item.title, description: item.description || '', referenceLinks: item.referenceLinks || [], sourceUrl: item.sourceUrl || null, sourceTitle: item.sourceTitle || '', originalText: item.title, workspaceId, status: next ? 'next' : 'inbox', ...membershipFields([destination]) } };
  })];
}
export function areaMappingMutations(records, tag, target, title, workspaceId) {
  const existing = target && records[refKey(target)];
  if (target && (!existing || existing.deleted || collectionKind(existing) !== 'area')) throw new Error('Choose an available Area.');
  if (!tag) throw new Error('Choose an existing area tag.');
  if (!target && (!title.trim() || title.length > 200)) throw new Error('Name the new Area (1–200 characters).');
  const ref = target || { type: 'list', id: crypto.randomUUID() };
  const candidates = Object.values(records).filter(record => record.type === 'item' && !record.deleted && record.areas?.includes(tag) && !belongsTo(record, ref));
  const batch = candidates.slice(0, target ? 20 : 19);
  if (!batch.length && target) throw new Error('All items with this tag are already linked.');
  const mutations = target ? [] : [{ type: 'list', id: ref.id, action: 'create', expectedVersion: 0, fields: { title, kind: 'area', workspaceId } }];
  for (const item of batch) mutations.push({ type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: membershipFields([...memberships(item), ref], item) });
  return { mutations, ref, remaining: candidates.length - batch.length };
}
