import { ValidationError } from '../shared/validate.mjs';
import { object, identifier, canonical } from './contract.mjs';
import { calendarDate, workflowFields } from './workflow.mjs';

const fail = message => { throw new ValidationError(message); };
export function reviewFields(action, input) {
  object(input, action === 'create' ? ['reviewKind', 'reviewDay', 'included', 'decisions'] : ['decisions'], 'review');
  if (action === 'create') {
    // ponytail: bounded session records; paginate history if real reviews exceed the v1 byte cap.
    if (!['daily', 'weekly'].includes(input.reviewKind)) fail('Choose a daily or weekly review.');
    if (!calendarDate(input.reviewDay, 'reviewDay')) fail('reviewDay is required.');
    if (!Array.isArray(input.included) || input.included.length > 200) fail('A review supports up to 200 records.');
    const seen = new Set();
    for (const ref of input.included) {
      object(ref, ['type', 'id'], 'included'); identifier(ref.id);
      if (!['item', 'project'].includes(ref.type) || seen.has(`${ref.type}:${ref.id}`)) fail('Review references must be unique items or projects.');
      seen.add(`${ref.type}:${ref.id}`);
    }
  }
  if (!Array.isArray(input.decisions) || input.decisions.length > 200 || action === 'create' && input.decisions.length) fail('Start with no decisions; a review supports up to 200 decision entries.');
  for (const decision of input.decisions) {
    object(decision, ['index', 'choice', 'recordVersion', 'before', 'after'], 'decision');
    if (!Number.isSafeInteger(decision.index) || decision.index < 0 || !Number.isSafeInteger(decision.recordVersion) || decision.recordVersion < 0 ||
        !['retain', 'drop', 'defer', 'unavailable', 'undo'].includes(decision.choice)) fail('Invalid review decision.');
    for (const name of ['before', 'after']) {
      object(decision[name], workflowFields, name);
      if (JSON.stringify(decision[name]).length > 6000) fail('Review decision is too large.');
    }
  }
  return structuredClone(input);
}
export const workflowSnapshot = record => record.type === 'project' ? {} : Object.fromEntries(workflowFields.map(name => [name, record[name] ?? (name === 'waitingOn' ? '' : name === 'status' ? 'inbox' : null)]));

// The decision and its canonical action edit must share one version-checked batch.
export async function validateReview(record, old, mutations, records, readRecord) {
  if (record.deleted) fail('Review history cannot be deleted through this operation.');
  if (!old) {
    for (const ref of record.included) {
      const target = await readRecord(ref);
      if (!target || target.deleted) fail('A review reference is unavailable in this account. Refresh before starting.');
    }
    return;
  }
  if (record.decisions.length !== old.decisions.length + 1 || canonical(record.decisions.slice(0, -1)) !== canonical(old.decisions)) fail('Append one decision without rewriting review history.');
  const decision = record.decisions.at(-1), ref = record.included[decision.index];
  if (!ref) fail('Decision is outside this review.');
  const prior = [...old.decisions].reverse().find(entry => entry.index === decision.index);
  if (decision.choice !== 'undo' && prior && prior.choice !== 'undo') fail('Undo the prior decision before changing it.');
  const target = await readRecord(ref);
  const mutation = mutations.find(m => m.type === ref.type && m.id === ref.id);
  if (decision.choice === 'unavailable') {
    if (target && !target.deleted || mutation || decision.recordVersion !== (target?.version ?? 0) || canonical(decision.before) !== '{}' || canonical(decision.after) !== '{}') fail('Only a missing or deleted record can be marked unavailable.');
    return;
  }
  if (!target || target.deleted || !mutation || mutation.action !== 'update' || mutation.expectedVersion !== decision.recordVersion || target.version !== decision.recordVersion) fail('Review the current record before deciding.');
  let expected;
  if (decision.choice === 'retain') expected = { title: target.title };
  else if (decision.choice === 'undo') {
    if (!prior || ['undo', 'unavailable'].includes(prior.choice) || target.version !== prior.recordVersion + 1) fail('This record changed since the decision; review its latest state instead of undoing.');
    expected = ref.type === 'project' || prior.choice === 'retain' ? { title: target.title } : prior.before;
  } else if (ref.type !== 'item') fail('Review project actions individually; projects support retain.');
  else if (decision.choice === 'drop') expected = { status: 'dropped' };
  else {
    const day = calendarDate(mutation.fields.startDate, 'Deferred until');
    if (!day) fail('Choose a date to defer this item.');
    expected = { status: 'deferred', startDate: day, startDateUtc: null };
  }
  const next = records.find(r => r.type === ref.type && r.id === ref.id);
  if (canonical(expected) !== canonical(mutation.fields) || canonical(decision.before) !== canonical(workflowSnapshot(target)) || canonical(decision.after) !== canonical(workflowSnapshot(next))) fail('The decision must match the exact action edit and its prior state.');
}
