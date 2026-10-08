import { ValidationError } from '../shared/validate.mjs';
import { materializationDate, nextAfterResolution, occurrenceId, recurrenceSnapshot } from './recurrence-model.mjs';

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = message => { throw new ValidationError(message); };
const cursor = ['nextOccurrenceNumber', 'nextIntendedDate', 'openOccurrenceId', 'lastResolvedUtc'];
const immutableOccurrence = ['recurrenceTemplateId', 'recurrenceNumber', 'intendedDate', 'sourceTemplateVersion'];
const organization = ['workspaceId', 'collectionRefs', 'listId', 'projectId'];

export async function validateRecurrence(record, old, mutation, records, lookup, now) {
  if (record.type === 'recurrenceTemplate') {
    if (record.deleted) fail('Recurring templates are stopped, not deleted.');
    if (!old) return;
    const changed = name => !equal(record[name] ?? null, old[name] ?? null);
    const opening = !old.openOccurrenceId && record.openOccurrenceId;
    const resolving = old.openOccurrenceId && !record.openOccurrenceId;
    if (old.tombstoned && !(resolving && Object.keys(mutation.fields).every(name => cursor.includes(name)))) {
      fail('A stopped recurring template is read-only history.');
    }
    if (!cursor.some(changed)) return;
    const rescheduled = !old.openOccurrenceId && !record.openOccurrenceId && !equal(record.rule, old.rule) && record.nextOccurrenceNumber === old.nextOccurrenceNumber && record.lastResolvedUtc === old.lastResolvedUtc &&
      record.nextIntendedDate === (record.lastResolvedUtc ? nextAfterResolution(record.rule, record.lastResolvedUtc) : record.rule.anchorDate);
    if (rescheduled) return;
    if (opening) {
      const occurrence = records.find(candidate => candidate.type === 'item' && candidate.id === record.openOccurrenceId);
      const occurrenceMutation = occurrence && records.indexOf(occurrence);
      if (!occurrence || mutation.action !== 'update' || occurrenceMutation < 0 || occurrence.version !== 1) fail('Materialization must atomically create its occurrence.');
      if (record.nextOccurrenceNumber !== old.nextOccurrenceNumber + 1 || occurrence.recurrenceNumber !== old.nextOccurrenceNumber || occurrence.id !== occurrenceId(old.id, old.nextOccurrenceNumber)) fail('Recurring occurrence identity or cursor is invalid.');
      const intended = materializationDate(old, new Date(now));
      if (!intended || occurrence.intendedDate !== intended || record.nextIntendedDate !== intended) fail('Recurring occurrence intended date is invalid.');
      if (occurrence.recurrenceTemplateId !== old.id || occurrence.sourceTemplateVersion !== old.version || occurrence.occurrenceState !== 'open' || occurrence.occurrenceResolvedUtc !== null) fail('Recurring occurrence linkage is invalid.');
      if (occurrence.workspaceId !== old.workspaceId || !equal(recurrenceSnapshot(occurrence), recurrenceSnapshot(old))) fail('Recurring occurrence must match the template snapshot.');
      return;
    }
    if (resolving) {
      const occurrence = records.find(candidate => candidate.type === 'item' && candidate.id === old.openOccurrenceId);
      if (!occurrence || occurrence.recurrenceTemplateId !== old.id || !['completed', 'skipped'].includes(occurrence.occurrenceState)) fail('Resolution must atomically update the open occurrence.');
      if (record.nextOccurrenceNumber !== old.nextOccurrenceNumber || record.lastResolvedUtc !== occurrence.occurrenceResolvedUtc) fail('Resolution cursor is invalid.');
      const expected = old.tombstoned ? old.nextIntendedDate : nextAfterResolution(record.rule, occurrence.occurrenceResolvedUtc);
      if (record.nextIntendedDate !== expected) fail('The next recurring date is invalid.');
      return;
    }
    fail('Recurrence cursors may change only with a linked occurrence transition.');
  }

  if (record.type !== 'item') return;
  const linked = record.recurrenceTemplateId || old?.recurrenceTemplateId;
  if (!linked) {
    if (['recurrenceTemplateId', 'recurrenceNumber', 'intendedDate', 'sourceTemplateVersion', 'occurrenceState', 'occurrenceResolvedUtc'].some(name => name in (mutation.fields || {}))) fail('Ordinary items cannot forge recurrence fields.');
    return;
  }
  if (record.deleted) fail('A live recurring occurrence must be completed or skipped, not deleted.');
  const template = records.find(candidate => candidate.type === 'recurrenceTemplate' && candidate.id === linked) ?? await lookup('recurrenceTemplate', linked);
  if (!template) fail('Recurring occurrence requires its template.');
  if (!old) {
    const paired = records.find(candidate => candidate.type === 'recurrenceTemplate' && candidate.id === linked && candidate.openOccurrenceId === record.id);
    if (!paired || record.id !== occurrenceId(linked, record.recurrenceNumber)) fail('Recurring occurrence creation requires the paired template cursor.');
    return;
  }
  for (const name of immutableOccurrence) if (!equal(record[name], old[name])) fail('Recurring occurrence identity and intended date are immutable.');
  if (record.workspaceId !== old.workspaceId && template.workspaceId !== record.workspaceId) fail('Move the recurring template and its history together.');
  if (old.occurrenceState !== 'open') {
    if (Object.keys(mutation.fields).every(name => organization.includes(name)) && template.workspaceId === record.workspaceId) return;
    fail('Completed and skipped occurrences are read-only history.');
  }
  const terminal = record.occurrenceState !== 'open';
  if (!terminal) {
    if (record.occurrenceResolvedUtc !== null || ['completed', 'dropped'].includes(record.status)) fail('Complete or skip recurring work through its terminal action.');
    return;
  }
  if (record.occurrenceState === 'completed' ? record.status !== 'completed' : record.status !== 'dropped') fail('Completed and skipped occurrence states must match item status.');
  if (!record.occurrenceResolvedUtc) fail('A resolved occurrence needs its UTC resolution time.');
  const paired = records.find(candidate => candidate.type === 'recurrenceTemplate' && candidate.id === linked && candidate.openOccurrenceId === null);
  if (!paired || template.openOccurrenceId !== null) fail('Occurrence resolution requires the paired template cursor update.');
}

export function recurrenceAlreadySatisfied(input, current, sequence) {
  if (input.mutations.length !== 2) return null;
  const templateMutation = input.mutations.find(mutation => mutation.type === 'recurrenceTemplate');
  const itemMutation = input.mutations.find(mutation => mutation.type === 'item' && mutation.action === 'create');
  if (!templateMutation || templateMutation.action !== 'update' || !itemMutation ||
      itemMutation.fields.recurrenceTemplateId !== templateMutation.id || templateMutation.fields.openOccurrenceId !== itemMutation.id ||
      templateMutation.fields.nextOccurrenceNumber !== itemMutation.fields.recurrenceNumber + 1 || templateMutation.fields.nextIntendedDate !== itemMutation.fields.intendedDate ||
      itemMutation.fields.sourceTemplateVersion !== templateMutation.expectedVersion || itemMutation.fields.occurrenceState !== 'open' || itemMutation.fields.occurrenceResolvedUtc !== null) return null;
  const template = current[input.mutations.indexOf(templateMutation)]?.record;
  const item = current[input.mutations.indexOf(itemMutation)]?.record;
  if (!template || !item || template.version !== templateMutation.expectedVersion + 1 || item.version !== 1) return null;
  const expectedTemplate = { ...templateMutation.fields, id: templateMutation.id, type: 'recurrenceTemplate' };
  const expectedItem = { ...itemMutation.fields, id: itemMutation.id, type: 'item' };
  if (!Object.entries(expectedTemplate).every(([name, value]) => equal(template[name], value)) || !Object.entries(expectedItem).every(([name, value]) => equal(item[name], value))) return null;
  return { apiVersion: 1, accountId: input.accountId, operationId: input.operationId, sequence, status: 'committed', records: [template, item] };
}
