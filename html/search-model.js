import { ancestry, archiveOnly, archivedAncestor, collectionKind, isCollection, isEffectivelyArchived, memberships, refKey } from './collection-model.js?v=5';

const searchableTypes = new Set(['item', 'list', 'project']);
const inactiveStatuses = new Set(['completed', 'dropped', 'someday', 'on-hold', 'reference']);

export const defaultSearch = () => ({ query: '', resultType: 'all', resultState: 'active' });

export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

export function collectionPaths(record, records) {
  const refs = record.type === 'item' ? memberships(record) : record.parentRef ? [record.parentRef] : [];
  return refs.map(ref => ancestry(ref, records).reverse().map(candidate => records[refKey(candidate)]?.title).filter(Boolean).join(' / ')).filter(Boolean);
}

export function matchesSearchState(record, resultState, records) {
  if (resultState === 'all') return true;
  if (resultState === 'archived') {
    return isCollection(record) ? isEffectivelyArchived(record, records) : memberships(record).some(ref => archivedAncestor(ref, records));
  }
  if (resultState.startsWith('status:')) {
    const status = resultState.slice(7);
    return record.status === status || status === 'reference' && isCollection(record) && collectionKind(record) === 'reference';
  }
  if (resultState !== 'active') return false;
  if (isCollection(record)) {
    return !isEffectivelyArchived(record, records) && collectionKind(record) !== 'reference' && !inactiveStatuses.has(record.status);
  }
  return !archiveOnly(record, records) && !inactiveStatuses.has(record.status);
}

export function searchWorkspace(records, filters = defaultSearch()) {
  const query = normalizeSearchText(String(filters.query ?? '').trim());
  // ponytail: linear scan is sufficient for current workspace sizes; add an index only if measured search latency warrants it.
  return Object.values(records).filter(record => {
    if (record.deleted || !searchableTypes.has(record.type)) return false;
    if (filters.resultType !== 'all' && record.type !== filters.resultType) return false;
    if (!matchesSearchState(record, filters.resultState, records)) return false;
    if (!query) return true;
    return normalizeSearchText([
      record.title, record.description, record.originalText, record.outcome,
      ...collectionPaths(record, records)
    ].filter(Boolean).join('\n')).includes(query);
  }).sort((left, right) => normalizeSearchText(left.title).localeCompare(normalizeSearchText(right.title)) ||
    left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
}
