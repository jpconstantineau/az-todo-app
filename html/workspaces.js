export const PERSONAL = 'personal';
export function workspaceOf(record, records) {
  if (record?.type === 'clarification') return records[`item:${record.id}`]?.workspaceId || PERSONAL;
  if (record?.type === 'brief') return records[`${record.subjectType}:${record.subjectId}`]?.workspaceId || PERSONAL;
  return record?.workspaceId || PERSONAL;
}
export function workspaceRecords(records, workspaceId) {
  const space = records[`workspace:${workspaceId}`];
  if (space?.deleted) return {};
  return Object.fromEntries(Object.entries(records).filter(([, record]) =>
    record.type === 'settings' || record.type !== 'workspace' && workspaceOf(record, records) === workspaceId));
}
export function workspaceDraft(state, workspaceId) {
  if (workspaceId === PERSONAL) return state.draft;
  state.workspaceDrafts ??= {};
  return state.workspaceDrafts[workspaceId] ??= {};
}
