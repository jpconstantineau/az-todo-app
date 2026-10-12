export const EXECUTION_STATES = ['started', 'paused', 'blocked'];
export const policyKey = workspaceId => `executionPolicy:${workspaceId}`;
export const executionCount = policy => (policy?.entries || []).filter(entry => ['started', 'blocked'].includes(entry.state)).length;
export const activeEntry = (policy, itemId) => policy?.entries?.find(entry => entry.itemId === itemId) || null;

export function validateExecutionPolicy(policy) {
  if (!policy || policy.id !== policy.workspaceId) throw new Error('Active-work policy identity must match its workspace.');
  if (!Number.isSafeInteger(policy.wipLimit) || policy.wipLimit < 1 || policy.wipLimit > 20) throw new Error('Choose a WIP limit from 1 to 20.');
  if (!Array.isArray(policy.entries) || policy.entries.length > 40) throw new Error('Active work supports at most 40 items.');
  if (new Set(policy.entries.map(entry => entry.itemId)).size !== policy.entries.length) throw new Error('An item can appear in active work only once.');
  for (const entry of policy.entries) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.itemId || '') || !EXECUTION_STATES.includes(entry.state) ||
        !Number.isSafeInteger(entry.observedItemVersion) || entry.observedItemVersion < 1 || typeof entry.override !== 'boolean') throw new Error('Active-work entry is invalid.');
    if (entry.state === 'paused' && entry.override) throw new Error('Paused work cannot retain a WIP override because it does not count toward WIP.');
    if (entry.state === 'blocked') {
      if (typeof entry.blockedReason !== 'string' || !entry.blockedReason.trim() || entry.blockedReason.length > 500) throw new Error('Blocked work needs a 1–500 character reason.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewDate || '') || !Number.isFinite(Date.parse(entry.reviewDate)) || new Date(entry.reviewDate).toISOString().slice(0, 10) !== entry.reviewDate) throw new Error('Blocked work needs a valid review date.');
    } else if (entry.blockedReason !== null || entry.reviewDate !== null) throw new Error('Only blocked work can retain a blocked reason and review date.');
  }
  if (executionCount(policy) > policy.wipLimit && policy.entries.filter(entry => ['started', 'blocked'].includes(entry.state) && entry.override).length < executionCount(policy) - policy.wipLimit) {
    throw new Error('Every WIP slot above the limit needs an explicit override.');
  }
  return policy;
}

export function policyFields(policy) {
  return { wipLimit: policy.wipLimit, entries: policy.entries.map(entry => ({ ...entry })) };
}

export function transitionPolicy(policy, item, state, { reason = null, reviewDate = null, override = false } = {}) {
  const entries = (policy.entries || []).filter(entry => entry.itemId !== item.id);
  if (state) entries.push({ itemId: item.id, state, blockedReason: state === 'blocked' ? reason : null,
    reviewDate: state === 'blocked' ? reviewDate : null, override: Boolean(override), observedItemVersion: item.version });
  const next = { ...policy, entries };
  validateExecutionPolicy(next);
  return next;
}

export function cleanupExecutionPolicy(records, mutations) {
  const removals = new Map();
  for (const mutation of mutations) {
    if (mutation.type !== 'item') continue;
    const current = records[`item:${mutation.id}`];
    if (!current) continue;
    const next = { ...current, ...mutation.fields, deleted: mutation.action === 'delete' };
    if (!next.deleted && next.workspaceId === current.workspaceId && ['inbox', 'next'].includes(next.status)) continue;
    const policy = records[policyKey(current.workspaceId)];
    if (policy?.entries?.some(entry => entry.itemId === current.id)) {
      if (!removals.has(current.workspaceId)) removals.set(current.workspaceId, new Set());
      removals.get(current.workspaceId).add(current.id);
    }
  }
  return [...removals].map(([workspaceId, ids]) => {
    const policy = records[policyKey(workspaceId)];
    return { mutation: { type: 'executionPolicy', id: workspaceId, action: 'update', expectedVersion: policy.version,
      fields: { entries: policy.entries.filter(entry => !ids.has(entry.itemId)) } }, itemIds: [...ids] };
  });
}

export function retryExecutionCleanupMutations(mutations, records) {
  return mutations.filter(mutation => mutation.type !== 'executionPolicy').map(mutation => {
    const current = records[`${mutation.type}:${mutation.id}`];
    if (mutation.action === 'create') {
      if (current) throw new Error('A related record changed. Use server active work and review the latest item before repeating this action.');
      return mutation;
    }
    const expectedDeleted = mutation.action === 'restore';
    if (!current || current.version !== mutation.expectedVersion || Boolean(current.deleted) !== expectedDeleted) {
      throw new Error('A related record changed. Use server active work and review the latest item before repeating this action.');
    }
    return mutation;
  });
}
