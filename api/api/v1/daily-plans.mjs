import { ValidationError } from '../shared/validate.mjs';
import { calendarDate } from './workflow.mjs';

const METHODS = ['none', 'tshirt', 'fibonacci'];
const ASSESSMENTS = ['needs_assessment', 'needs_reassessment', 'fits', 'full', 'overcommitted'];
const OPERATIONS = ['add', 'quick_add', 'remove', 'reorder', 'assessment', 'estimate', 'carryover_keep', 'carryover_move', 'carryover_remove'];
const TSHIRT = ['XS', 'S', 'M', 'L', 'XL'];
const FIBONACCI = [1, 2, 3, 5, 8, 13];

const fail = message => { throw new ValidationError(message); };
const canonical = value => JSON.stringify(value, function (key, entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry;
});
const identifier = (value, field = 'id') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(`${field} must contain 1–128 letters, numbers, underscores or hyphens.`);
  return value;
};
const object = (value, allowed, field) => {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${field} must be an object.`);
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) fail(`${field}.${extra} is not supported.`);
};
const uniqueIds = (value, field) => {
  if (!Array.isArray(value) || value.length > 200) fail(`${field} must contain at most 200 action IDs.`);
  const ids = value.map(id => identifier(id, field));
  if (new Set(ids).size !== ids.length) fail(`${field} must contain unique action IDs.`);
  return ids;
};
const assessment = value => {
  if (!ASSESSMENTS.includes(value)) fail('Choose a supported load assessment.');
  return value;
};

export function effortEstimate(value) {
  if (value === null) return null;
  object(value, ['scale', 'value'], 'effortEstimate');
  if (value.scale === 'tshirt' && TSHIRT.includes(value.value)) return structuredClone(value);
  if (value.scale === 'fibonacci' && FIBONACCI.includes(value.value)) return structuredClone(value);
  fail('Estimate must be a tagged T-shirt or Fibonacci value.');
}

function carryover(value) {
  if (!Array.isArray(value) || value.length > 200) fail('carryoverDecisions must contain at most 200 decisions.');
  const seen = new Set();
  return value.map((entry, index) => {
    object(entry, ['actionId', 'sourceDay', 'choice'], `carryoverDecisions[${index}]`);
    const actionId = identifier(entry.actionId, 'actionId');
    calendarDate(entry.sourceDay, 'sourceDay');
    if (!['keep', 'move', 'remove'].includes(entry.choice) || seen.has(`${entry.sourceDay}:${actionId}`)) fail('Carryover decisions must be unique keep, move or remove choices.');
    seen.add(`${entry.sourceDay}:${actionId}`);
    return { actionId, sourceDay: entry.sourceDay, choice: entry.choice };
  });
}

function snapshot(value, field) {
  object(value, ['actionIds', 'loadAssessment'], field);
  return { actionIds: uniqueIds(value.actionIds, `${field}.actionIds`), loadAssessment: assessment(value.loadAssessment) };
}

function taggedEstimates(value) {
  if (!Array.isArray(value) || value.length > 200) fail('estimates must contain at most 200 tagged values.');
  const seen = new Set();
  return value.map((entry, index) => {
    object(entry, ['actionId', 'estimate'], `estimates[${index}]`);
    const actionId = identifier(entry.actionId, 'actionId');
    if (seen.has(actionId)) fail('estimates must contain unique action IDs.');
    seen.add(actionId);
    return { actionId, estimate: effortEstimate(entry.estimate) };
  });
}

export function dailyPlanFields(type, action, input) {
  if (action === 'delete' || action === 'restore') fail('Planning records cannot be deleted or restored.');
  if (type === 'planPreference') {
    object(input, ['workspaceId', 'estimationMethod'], 'fields');
    const result = {};
    if ('workspaceId' in input) result.workspaceId = identifier(input.workspaceId, 'workspaceId');
    if ('estimationMethod' in input) {
      if (!METHODS.includes(input.estimationMethod)) fail('Choose None, T-shirt or Fibonacci estimation.');
      result.estimationMethod = input.estimationMethod;
    }
    if (action === 'create' && (!result.workspaceId || !result.estimationMethod)) fail('workspaceId and estimationMethod are required.');
    if (!Object.keys(result).length) fail('fields must contain an edit.');
    return result;
  }
  if (type === 'dailyPlan') {
    object(input, ['workspaceId', 'planDay', 'actionIds', 'loadAssessment', 'carryoverDecisions', 'revisionHead', 'revisionCount'], 'fields');
    const result = {};
    if ('workspaceId' in input) result.workspaceId = identifier(input.workspaceId, 'workspaceId');
    if ('planDay' in input) result.planDay = calendarDate(input.planDay, 'planDay');
    if ('actionIds' in input) result.actionIds = uniqueIds(input.actionIds, 'actionIds');
    if ('loadAssessment' in input) result.loadAssessment = assessment(input.loadAssessment);
    if ('carryoverDecisions' in input) result.carryoverDecisions = carryover(input.carryoverDecisions);
    if ('revisionHead' in input) result.revisionHead = identifier(input.revisionHead, 'revisionHead');
    if ('revisionCount' in input) {
      if (!Number.isSafeInteger(input.revisionCount) || input.revisionCount < 1) fail('revisionCount must be a positive integer.');
      result.revisionCount = input.revisionCount;
    }
    if (action === 'create' && (!result.workspaceId || !result.planDay || !result.revisionHead || result.revisionCount !== 1 || !result.actionIds || !result.loadAssessment || !result.carryoverDecisions)) fail('A new daily plan requires its date, order, assessment, carryover decisions and first revision.');
    if (!Object.keys(result).length) fail('fields must contain an edit.');
    return result;
  }
  object(input, ['workspaceId', 'planId', 'planDay', 'sequence', 'operationKind', 'before', 'after', 'carryoverDecision', 'estimates'], 'fields');
  if (action !== 'create') fail('Daily plan revisions are immutable.');
  const { workspaceId, planId, planDay, sequence, operationKind } = input;
  identifier(workspaceId, 'workspaceId'); identifier(planId, 'planId'); calendarDate(planDay, 'planDay');
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !OPERATIONS.includes(operationKind)) fail('Invalid daily plan revision sequence or operation kind.');
  const before = snapshot(input.before, 'before'), after = snapshot(input.after, 'after');
  let carryoverDecision = null;
  if (input.carryoverDecision !== null) carryoverDecision = carryover([input.carryoverDecision])[0];
  return { workspaceId, planId, planDay, sequence, operationKind, before, after, carryoverDecision, estimates: taggedEstimates(input.estimates) };
}

export async function validateDailyPlan(plan, old, records, lookup, mutations) {
  if (plan.deleted) fail('Daily plans cannot be deleted.');
  if (plan.id !== `${plan.workspaceId}_${plan.planDay}`) fail('Daily plan identity must be deterministic for its workspace and date.');
  const revision = records.find(record => record.type === 'dailyPlanRevision' && record.id === plan.revisionHead);
  if (!revision || revision.planId !== plan.id || revision.sequence !== plan.revisionCount || revision.workspaceId !== plan.workspaceId || revision.planDay !== plan.planDay) fail('Save the daily plan and its immutable revision together.');
  const expected = { actionIds: plan.actionIds, loadAssessment: plan.loadAssessment };
  if (canonical(revision.after) !== canonical(expected)) fail('The revision must describe the saved daily plan.');
  const estimates = [];
  for (const actionId of plan.actionIds) {
    const item = records.find(record => record.type === 'item' && record.id === actionId) ?? await lookup('item', actionId);
    if (!item || item.deleted || item.workspaceId !== plan.workspaceId || item.plannedDay !== plan.planDay) fail('Daily plan order may contain only canonical actions planned for this workspace and date.');
    estimates.push({ actionId, estimate: item.effortEstimate || null });
  }
  if (canonical(revision.estimates) !== canonical(estimates)) fail('The revision must retain every tagged estimate without conversion.');
  if (old) {
    if (plan.workspaceId !== old.workspaceId || plan.planDay !== old.planDay || plan.revisionCount !== old.revisionCount + 1 || revision.sequence !== old.revisionCount + 1 || revision.id === old.revisionHead) fail('Append exactly one revision without changing daily plan identity.');
    if (canonical(revision.before) !== canonical({ actionIds: old.actionIds, loadAssessment: old.loadAssessment })) fail('The revision must retain the prior order and assessment.');
    const estimateChanged = mutations.some(mutation => mutation.type === 'item' && Object.hasOwn(mutation.fields || {}, 'effortEstimate') &&
      (old.actionIds.includes(mutation.id) || plan.actionIds.includes(mutation.id)));
    if ((canonical(old.actionIds) !== canonical(plan.actionIds) || estimateChanged) && ['fits', 'full', 'overcommitted'].includes(old.loadAssessment) && plan.loadAssessment !== 'needs_reassessment') {
      fail('Membership or estimate changes must reset an accepted load assessment to Needs reassessment.');
    }
  } else if (revision.sequence !== 1 || revision.before.actionIds.length || revision.before.loadAssessment !== 'needs_assessment') fail('The first revision must begin with an empty unassessed plan.');
}

export function validateDailyPlanRevision(revision, old, records) {
  if (old || revision.deleted || revision.id.length > 36) fail('Daily plan revisions are immutable and require an ID of at most 36 characters.');
  const plan = records.find(record => record.type === 'dailyPlan' && record.id === revision.planId);
  if (!plan || plan.revisionHead !== revision.id || plan.revisionCount !== revision.sequence) fail('Save the revision and daily plan together.');
}
