import { belongsTo, collectionKind, isEffectivelyArchived, refKey } from './collection-model.js?v=5';

// The review deliberately ignores display filters and nested-only memberships.
export function checklistResetPlan(records, checklist, workspaceId) {
  const current = checklist && records[refKey(checklist)];
  if (!current || current.type !== 'list' || current.deleted || current.workspaceId !== workspaceId || collectionKind(current) !== 'checklist' ||
      isEffectivelyArchived(current, records)) return null;
  const items = Object.values(records).filter(item => item.type === 'item' && !item.deleted &&
    item.workspaceId === workspaceId && item.status === 'completed' && !item.recurrenceTemplateId && belongsTo(item, current))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { checklist: { type: current.type, id: current.id, version: current.version }, workspaceId,
    mutations: items.map(item => ({ type: 'item', id: item.id, action: 'update', expectedVersion: item.version, fields: { status: 'next' } })) };
}
