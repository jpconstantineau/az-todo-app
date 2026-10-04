import { isCollection, memberships, refKey } from './collection-model.js';

export function collectionMoveMutations(record, workspaceId, records, fields) {
  const moving = new Set([refKey(record)]);
  let previousSize;
  do {
    previousSize = moving.size;
    for (const candidate of Object.values(records)) {
      if (isCollection(candidate) && !candidate.deleted && candidate.parentRef && moving.has(refKey(candidate.parentRef))) moving.add(refKey(candidate));
    }
  } while (moving.size !== previousSize);

  const dependents = Object.values(records).filter(candidate => !candidate.deleted &&
    (moving.has(refKey(candidate)) || candidate.type === 'item' && memberships(candidate).some(ref => moving.has(refKey(ref)))));
  if (dependents.length > 20) throw new Error('This collection has more than 19 linked records. Move smaller groups of items first, then move the collection.');
  return dependents.map(candidate => {
    let changes;
    if (candidate.type === 'item') {
      const collectionRefs = memberships(candidate).filter(ref => moving.has(refKey(ref)));
      changes = { collectionRefs,
        listId: collectionRefs.some(ref => ref.type === 'list' && ref.id === candidate.listId) ? candidate.listId : collectionRefs.find(ref => ref.type === 'list')?.id || null,
        projectId: collectionRefs.some(ref => ref.type === 'project' && ref.id === candidate.projectId) ? candidate.projectId : collectionRefs.find(ref => ref.type === 'project')?.id || null };
    } else changes = { parentRef: candidate.parentRef && moving.has(refKey(candidate.parentRef)) ? candidate.parentRef : null };
    return { type: candidate.type, id: candidate.id, action: 'update', expectedVersion: candidate.version,
      fields: { ...(refKey(candidate) === refKey(record) ? fields : {}), ...changes, workspaceId } };
  });
}
