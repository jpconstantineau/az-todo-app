import { ValidationError } from '../shared/validate.mjs';
import { object, identifier, canonical } from './contract.mjs';
import { calendarDate, workflowFields } from './workflow.mjs';

const fail = message => { throw new ValidationError(message); };
export function reviewFields(action, input) {
  object(input, action === 'create' ? ['reviewKind', 'reviewDay', 'included', 'decisions', 'previousReviewId'] : ['decisions', 'decisionHeads', 'decisionCount'], 'review');
  if (action === 'create') {
    if (input.previousReviewId !== undefined) identifier(input.previousReviewId, 'previousReviewId');
    if (!['daily', 'weekly', 'someday'].includes(input.reviewKind)) fail('Choose a daily, weekly or someday project review.');
    if (!calendarDate(input.reviewDay, 'reviewDay')) fail('reviewDay is required.');
    if (!Array.isArray(input.included) || input.included.length > 200) fail('A review supports up to 200 records.');
    const seen = new Set();
    for (const ref of input.included) {
      object(ref, ['type', 'id'], 'included'); identifier(ref.id);
      if (!['item', 'project'].includes(ref.type) || seen.has(`${ref.type}:${ref.id}`)) fail('Review references must be unique items or projects.');
      seen.add(`${ref.type}:${ref.id}`);
    }
  }
  if (action === 'update' && 'decisionHeads' in input) {
    if ('decisions' in input || !Number.isSafeInteger(input.decisionCount) || input.decisionCount < 1 ||
        !Array.isArray(input.decisionHeads) || input.decisionHeads.length > 200) fail('Invalid review history pointers.');
    for (const id of input.decisionHeads) if (id !== null) {
      identifier(id, 'decision ID');
      if (id.length > 36) fail('Decision IDs must be at most 36 characters.');
    }
    return structuredClone(input);
  }
  if ('decisionCount' in input) fail('Review history pointers are required.');
  if (!Array.isArray(input.decisions) || input.decisions.length > 200 || action === 'create' && input.decisions.length) fail('Start with no decisions; a review supports up to 200 decision entries.');
  for (const decision of input.decisions) {
    object(decision, ['index', 'choice', 'recordVersion', 'before', 'after'], 'decision');
    if (!Number.isSafeInteger(decision.index) || decision.index < 0 || !Number.isSafeInteger(decision.recordVersion) || decision.recordVersion < 0 ||
        !['retain', 'drop', 'defer', 'complete', 'next', 'unavailable', 'undo'].includes(decision.choice)) fail('Invalid review decision.');
    for (const name of ['before', 'after']) {
      object(decision[name], workflowFields, name);
      if (JSON.stringify(decision[name]).length > 6000) fail('Review decision is too large.');
    }
  }
  return structuredClone(input);
}
export function reviewDecisionFields(action, input) {
  if (action !== 'create') fail('Review decisions are immutable.');
  object(input, ['reviewId', 'sequence', 'index', 'choice', 'recordVersion', 'before', 'changes'], 'review decision');
  identifier(input.reviewId, 'reviewId');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Number.isSafeInteger(input.index) || input.index < 0 ||
      !Number.isSafeInteger(input.recordVersion) || input.recordVersion < 0 ||
      !['retain', 'drop', 'defer', 'complete', 'next', 'unavailable', 'undo'].includes(input.choice)) fail('Invalid review decision.');
  for (const name of ['before', 'changes']) object(input[name], workflowFields, name);
  return structuredClone(input);
}
export const workflowSnapshot = record => record.type === 'project' ? {} : Object.fromEntries(workflowFields.map(name => [name, record[name] ?? (name === 'waitingOn' ? '' : name === 'status' ? 'inbox' : null)]));

// The decision and its canonical action edit must share one version-checked batch.
export async function validateReview(record, old, mutations, records, readRecord) {
  if (record.deleted) fail('Review history cannot be deleted through this operation.');
  if (!old) {
    if (record.previousReviewId) {
      const previous = await readRecord({ type: 'review', id: record.previousReviewId });
      if (!previous || previous.reviewKind !== record.reviewKind || previous.reviewDay !== record.reviewDay) fail('Continue a review in the same workspace, kind and day.');
    }
    for (const ref of record.included) {
      const target = await readRecord(ref);
      if (!target || target.deleted) fail('A review reference is unavailable in this account. Refresh before starting.');
    }
    return;
  }
  if (record.decisionCount !== old.decisionCount) {
    if (record.decisionCount !== (old.decisionCount || 0) + 1 || record.decisionHeads.length !== record.included.length) fail('Append exactly one review decision.');
    const changed = record.decisionHeads.flatMap((id, index) => id !== (old.decisionHeads?.[index] ?? null) ? [index] : []);
    if (changed.length !== 1) fail('Append exactly one review decision.');
    const index = changed[0], id = record.decisionHeads[index];
    const decision = records.find(r => r.type === 'reviewDecision' && r.id === id);
    if (!decision || decision.reviewId !== record.id || decision.index !== index || decision.sequence !== record.decisionCount) fail('Save the decision and review progress together.');
    const prior = old.decisionHeads?.[index]
      ? await readRecord({ type: 'reviewDecision', id: old.decisionHeads[index] })
      : [...old.decisions].reverse().find(entry => entry.index === index);
    await validateDecision(record, decision, prior, mutations, records, readRecord);
    return;
  }
  if (old.decisionCount) fail('This review uses separate history. Update the app before continuing.');
  if (record.decisions.length !== old.decisions.length + 1 || canonical(record.decisions.slice(0, -1)) !== canonical(old.decisions)) fail('Append one decision without rewriting review history.');
  const decision = record.decisions.at(-1);
  const prior = [...old.decisions].reverse().find(entry => entry.index === decision.index);
  await validateDecision(record, decision, prior, mutations, records, readRecord);
}

export function validateReviewDecision(record, old, records) {
  if (old || record.deleted || record.id.length > 36) fail('Review decisions are immutable and require an ID of at most 36 characters.');
  const review = records.find(r => r.type === 'review' && r.id === record.reviewId);
  if (!review || review.decisionHeads?.[record.index] !== record.id || review.decisionCount !== record.sequence) fail('Save the decision and review progress together.');
}

async function validateDecision(record, decision, prior, mutations, records, readRecord) {
  const ref = record.included[decision.index];
  if (!ref) fail('Decision is outside this review.');
  const after = decision.changes ? { ...decision.before, ...decision.changes } : decision.after;
  if (decision.choice !== 'undo' && prior && prior.choice !== 'undo') fail('Undo the prior decision before changing it.');
  const target = await readRecord(ref);
  const mutation = mutations.find(m => m.type === ref.type && m.id === ref.id);
  if (decision.choice === 'unavailable') {
    if (target && !target.deleted || mutation || decision.recordVersion !== (target?.version ?? 0) || canonical(decision.before) !== '{}' || canonical(after) !== '{}') fail('Only a missing or deleted record can be marked unavailable.');
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
  else if (decision.choice === 'complete') expected = { status: 'completed' };
  else if (decision.choice === 'next') expected = { status: 'next' };
  else {
    const day = calendarDate(mutation.fields.startDate, 'Deferred until');
    if (!day) fail('Choose a date to defer this item.');
    expected = { status: 'deferred', startDate: day, startDateUtc: null };
  }
  const next = records.find(r => r.type === ref.type && r.id === ref.id);
  if (canonical(expected) !== canonical(mutation.fields) || canonical(decision.before) !== canonical(workflowSnapshot(target)) || canonical(after) !== canonical(workflowSnapshot(next))) fail('The decision must match the exact action edit and its prior state.');
}
