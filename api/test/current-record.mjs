export function currentCreate(type, id, fields = {}) {
  const next = structuredClone(fields);
  if (['item', 'list', 'project', 'review'].includes(type)) next.workspaceId ??= 'personal';
  if (type === 'item') {
    next.status ??= 'inbox';
    next.collectionRefs ??= ['list', 'project'].filter(kind => next[`${kind}Id`]).map(kind => ({ type: kind, id: next[`${kind}Id`] }));
  }
  if (type === 'project') next.status ??= 'active';
  return { type, id, action: 'create', expectedVersion: 0, fields: next };
}
