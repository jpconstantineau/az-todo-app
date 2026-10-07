// Also shipped in api/api/v1/collection-model.mjs; a contract test keeps both runtimes identical.
export const collectionKinds = { list: 'List', checklist: 'Checklist', project: 'Project', area: 'Area', role: 'Role', initiative: 'Initiative', program: 'Program', reference: 'Reusable reference' };
export const refKey = ref => `${ref.type}:${ref.id}`;
export const isCollection = record => ['list', 'project'].includes(record?.type);
export const collectionKind = record => record.type === 'project' ? 'project' : record.kind || 'list';
export function validateRef(ref) {
  if (!ref || Array.isArray(ref) || typeof ref !== 'object' || Object.keys(ref).length !== 2 || !isCollection(ref) || typeof ref.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.id || '')) throw new Error('Choose a valid list or project reference.');
  return { type: ref.type, id: ref.id };
}
export function validateRefs(refs) {
  if (!Array.isArray(refs) || refs.length > 20) throw new Error('Choose at most 20 memberships.');
  const result = refs.map(validateRef);
  if (new Set(result.map(refKey)).size !== result.length) throw new Error('Each membership must be unique.');
  return result;
}
export function memberships(item) {
  return item?.collectionRefs ?? [];
}
export const belongsTo = (item, ref) => memberships(item).some(member => refKey(member) === refKey(ref));
export function normalizeMembership(record, old, fields = {}) {
  if (!['collectionRefs', 'listId', 'projectId'].some(name => name in fields)) return record;
  if (!('collectionRefs' in fields) && (!old || !Array.isArray(old.collectionRefs))) throw new Error('collectionRefs is required.');
  let refs = validateRefs('collectionRefs' in fields ? fields.collectionRefs : memberships(old));
  for (const type of ['list', 'project']) {
    const name = type + 'Id', previous = old?.[name] || null;
    if ('collectionRefs' in fields) {
      if (fields[name] && !refs.some(ref => ref.type === type && ref.id === fields[name])) throw new Error('Primary membership must also be selected in Organize in.');
      record[name] = name in fields ? fields[name] : refs.some(ref => ref.type === type && ref.id === previous) ? previous : refs.find(ref => ref.type === type)?.id || null;
    } else if (name in fields && (fields[name] || null) !== previous) {
      refs = refs.filter(ref => !(ref.type === type && ref.id === previous));
      if (fields[name] && !refs.some(ref => ref.type === type && ref.id === fields[name])) refs.push({ type, id: fields[name] });
    }
  }
  record.collectionRefs = validateRefs(refs);
  return record;
}
export function ancestry(ref, records) {
  const result = [], seen = new Set();
  while (ref && !seen.has(refKey(ref))) {
    seen.add(refKey(ref)); result.push(ref);
    ref = records[refKey(ref)]?.parentRef;
  }
  return result;
}
export function inCollection(item, ref, records, nested = false) {
  return memberships(item).some(member => (nested ? ancestry(member, records) : [member]).some(candidate => refKey(candidate) === refKey(ref)));
}
export function collectionContents(record, target) {
  return !record.deleted && (record.type === 'item' && belongsTo(record, target) || isCollection(record) && record.parentRef && refKey(record.parentRef) === refKey(target));
}
