export const PERSONAL = 'personal';
export function workspaceOf(record, records) {
  if (record?.type === 'reviewDecision') return records[`review:${record.reviewId}`]?.workspaceId;
  if (record?.type === 'clarification') return records[`item:${record.id}`]?.workspaceId;
  if (record?.type === 'brief') return records[`${record.subjectType}:${record.subjectId}`]?.workspaceId;
  return record?.workspaceId;
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
  if (!Object.hasOwn(state.workspaceDrafts, workspaceId)) {
    Object.defineProperty(state.workspaceDrafts, workspaceId, { value: {}, writable: true, enumerable: true, configurable: true });
  }
  return state.workspaceDrafts[workspaceId];
}
