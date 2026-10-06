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

function mutationWorkspace(mutation, records) {
  if (mutation.type === 'workspace') return mutation.id;
  const current = records[`${mutation.type}:${mutation.id}`];
  return mutation.fields?.workspaceId ?? workspaceOf({ ...current, ...mutation.fields, type: mutation.type, id: mutation.id }, records);
}

export function purgeWorkspaceState(state, workspaceId, erasedUtc) {
  const records = structuredClone(state.records);
  const scoped = new Set(Object.entries(records).filter(([, record]) =>
    record.type === 'workspace' ? record.id === workspaceId : workspaceOf(record, records) === workspaceId).map(([key]) => key));
  for (const key of scoped) delete state.records[key];
  state.queue = state.queue.filter(entry => !entry.operation.mutations.some(mutation =>
    scoped.has(`${mutation.type}:${mutation.id}`) || mutationWorkspace(mutation, records) === workspaceId));
  if (state.undoEdit && scoped.has(`${state.undoEdit.type}:${state.undoEdit.id}`)) delete state.undoEdit;
  if (state.workspaceMove && [state.workspaceMove.sourceWorkspaceId, state.workspaceMove.destinationWorkspaceId].includes(workspaceId)) delete state.workspaceMove;
  if (state.workspaceDrafts) delete state.workspaceDrafts[workspaceId];
  if (state.selectedWorkspace === workspaceId) state.selectedWorkspace = PERSONAL;
  state.workspaceErasureNotice = { workspaceId, erasedUtc };
}
