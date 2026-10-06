import { memberships, normalizeMembership } from './collection-model.js?v=2';

export const flowProposal = (item = {}) => ({
  view: 'classify', mode: 'file', title: item.title || '', parentRef: null, search: '', status: 'next',
  waitingOn: '', reviewDate: '', startDate: '', plannedDay: ''
});

export const newFlow = item => ({ flowVersion: 3, step: 'classify', decision: null, proposal: flowProposal(item) });

export function requireTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Title needs 1–200 characters.');
  return value;
}

export function membershipChange(item, destinationRef) {
  const refs = memberships(item);
  if (refs.some(ref => ref.type === destinationRef.type && ref.id === destinationRef.id)) return null;
  const fields = { collectionRefs: [...refs, destinationRef] };
  if (destinationRef.type === 'list' && !item.listId) fields.listId = destinationRef.id;
  if (destinationRef.type === 'project' && !item.projectId) fields.projectId = destinationRef.id;
  const normalized = normalizeMembership({ ...item, ...fields }, item, fields);
  return { collectionRefs: memberships(normalized), listId: normalized.listId || null, projectId: normalized.projectId || null };
}

export function itemFields(item, proposal, destinationRef) {
  const status = proposal.view === 'reference' ? 'reference' : proposal.view === 'someday' ? 'someday' : proposal.status;
  if (!['next', 'waiting', 'planned', 'deferred', 'completed', 'reference', 'someday'].includes(status)) throw new Error('Choose what should happen to this item.');
  const fields = { title: requireTitle(proposal.title), status };
  const filing = destinationRef ? membershipChange(item, destinationRef) : null;
  if (filing) Object.assign(fields, filing);
  if (status === 'waiting') {
    if (!proposal.waitingOn?.trim() || proposal.waitingOn.length > 4000) throw new Error('Waiting needs a person or dependency.');
    Object.assign(fields, { waitingOn: proposal.waitingOn, ...(proposal.reviewDate ? { reviewDate: proposal.reviewDate, reviewDateUtc: null } : {}) });
  }
  if (status === 'someday') Object.assign(fields, { reviewDate: proposal.reviewDate || null, reviewDateUtc: null });
  if (status === 'planned') {
    if (!proposal.plannedDay) throw new Error('Choose a planned day.');
    fields.status = 'next'; fields.plannedDay = proposal.plannedDay;
  }
  if (status === 'deferred') {
    if (!proposal.startDate) throw new Error('Choose a start date.');
    Object.assign(fields, { startDate: proposal.startDate, startDateUtc: null });
  }
  return fields;
}

export function beforeFields(item, fields) {
  const defaults = { collectionRefs: [], listId: null, projectId: null, waitingOn: '', reviewDate: null,
    reviewDateUtc: null, startDate: null, startDateUtc: null, plannedDay: null };
  return Object.fromEntries(Object.keys(fields).map(name => [name, structuredClone(item[name] ?? defaults[name] ?? null)]));
}
