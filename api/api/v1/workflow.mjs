import { ValidationError, utcDate } from '../shared/validate.mjs';

export const workflowFields = ['status', 'waitingOn', 'startDate', 'startDateUtc', 'reviewDate', 'reviewDateUtc'];
export function calendarDate(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      value.startsWith('0000') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${field} must be a valid YYYY-MM-DD calendar date or null.`);
  }
  return value;
}

export function applyWorkflow(record, old, fields = {}) {
  if (record.deleted) return;
  const changed = workflowFields.some(key => key in fields && (fields[key] ?? null) !== (old?.[key] ?? null));
  if (record.status === 'waiting' && !record.waitingOn?.trim()) {
    throw new ValidationError('Waiting needs who/what you are waiting for.');
  }
  if (record.status === 'deferred' && !(record.startDate || record.startDateUtc)) {
    throw new ValidationError('Deferred needs a start date; it becomes ready for review on that date.');
  }
  for (const name of ['due', 'start', 'review']) {
    if (record[`${name}Date`]) calendarDate(record[`${name}Date`], `${name}Date`);
    if (record[`${name}DateUtc`]) utcDate(record[`${name}DateUtc`]);
    if (record[`${name}Date`] && record[`${name}DateUtc`]) {
      throw new ValidationError(`Choose a calendar ${name} date or a timed ${name} date, not both.`);
    }
  }
  if (old && changed) {
    record.workflowBeforeTransition = Object.fromEntries(workflowFields.map(key => [key, old[key] ?? (key === 'waitingOn' ? '' : key === 'status' ? 'inbox' : null)]));
    record.completionBeforeTransition = old.statusBeforeCompletion || 'inbox';
  }
  if (record.status === 'completed' && old?.status !== 'completed') {
    const restoring = old?.workflowBeforeTransition?.status === 'completed' && workflowFields.every(key => (record[key] ?? null) === (old.workflowBeforeTransition[key] ?? null));
    record.statusBeforeCompletion = restoring ? old.completionBeforeTransition : old?.status || 'inbox';
  }
  record.nextAction = record.status === 'next';
}
