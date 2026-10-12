import { ValidationError } from '../shared/validate.mjs';
import { calendarDate } from './workflow.mjs';

export const executionStates = ['started', 'paused', 'blocked'];
export const countedExecutionStates = new Set(['started', 'blocked']);

const fail = message => { throw new ValidationError(message); };
const identifier = (value, field) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(`${field} must contain 1–128 letters, numbers, underscores or hyphens.`);
  return value;
};
const object = (value, allowed, field) => {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${field} must be an object.`);
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) fail(`${field}.${extra} is not supported.`);
};

function entry(value, index) {
  object(value, ['itemId', 'state', 'blockedReason', 'reviewDate', 'override', 'observedItemVersion'], `entries[${index}]`);
  const itemId = identifier(value.itemId, `entries[${index}].itemId`);
  if (!executionStates.includes(value.state)) fail(`entries[${index}].state must be started, paused or blocked.`);
  if (!Number.isSafeInteger(value.observedItemVersion) || value.observedItemVersion < 1) fail(`entries[${index}].observedItemVersion must be positive.`);
  if (typeof value.override !== 'boolean') fail(`entries[${index}].override must be true or false.`);
  if (value.state === 'paused' && value.override) fail('Paused work cannot retain a WIP override because it does not count toward WIP.');
  if (value.state === 'blocked') {
    if (typeof value.blockedReason !== 'string' || value.blockedReason.trim().length < 1 || value.blockedReason.length > 500) fail('Blocked work needs a 1–500 character reason.');
    if (!calendarDate(value.reviewDate, 'reviewDate')) fail('Blocked work needs a review date.');
  } else if (value.blockedReason !== null || value.reviewDate !== null) fail('Only blocked work can retain a blocked reason and review date.');
  return { itemId, state: value.state, blockedReason: value.blockedReason, reviewDate: value.reviewDate,
    override: value.override, observedItemVersion: value.observedItemVersion };
}

export function executionPolicyFields(action, input) {
  object(input, ['workspaceId', 'wipLimit', 'entries'], 'fields');
  if (action !== 'create' && 'workspaceId' in input) fail('executionPolicy.workspaceId is immutable.');
  const result = {};
  if ('workspaceId' in input) result.workspaceId = identifier(input.workspaceId, 'workspaceId');
  if ('wipLimit' in input) {
    if (!Number.isSafeInteger(input.wipLimit) || input.wipLimit < 1 || input.wipLimit > 20) fail('wipLimit must be an integer from 1 to 20.');
    result.wipLimit = input.wipLimit;
  }
  if ('entries' in input) {
    if (!Array.isArray(input.entries) || input.entries.length > 40) fail('entries must contain at most 40 active-work items.');
    result.entries = input.entries.map(entry);
    if (new Set(result.entries.map(value => value.itemId)).size !== result.entries.length) fail('Active-work item IDs must be unique.');
  }
  if (action === 'create' && (!result.workspaceId || !result.wipLimit || !result.entries)) fail('workspaceId, wipLimit and entries are required.');
  if (!Object.keys(result).length) fail('fields must contain an edit.');
  return result;
}

export const executionCount = policy => (policy?.entries || []).filter(entry => countedExecutionStates.has(entry.state)).length;

export async function validateExecutionPolicy(record, old, lookup) {
  if (record.deleted) fail('Active-work policy is reset by updating it, not deleting it.');
  if (record.id !== record.workspaceId || old && old.workspaceId !== record.workspaceId) fail('Active-work policy identity must match its workspace.');
  const previous = new Map((old?.entries || []).map(entry => [entry.itemId, entry]));
  const changedCounted = [];
  for (const value of record.entries) {
    const prior = previous.get(value.itemId);
    const changed = !prior || JSON.stringify(prior) !== JSON.stringify(value);
    const item = await lookup('item', value.itemId);
    if (!item || item.deleted || item.workspaceId !== record.workspaceId) {
      if (changed) fail('Active work may reference only live items in this workspace.');
      continue; // A concurrent terminal change remains visible and counted until reviewed.
    }
    if (changed) {
      if (!['inbox', 'next'].includes(item.status)) fail('Only work currently ready in Do can enter or change active state.');
      if (item.version !== value.observedItemVersion) fail('The item changed while active work was being updated. Review its latest version.');
    }
    if (countedExecutionStates.has(value.state) && (!prior || !countedExecutionStates.has(prior.state))) changedCounted.push(value);
  }
  const beforeCount = executionCount(old), afterCount = executionCount(record);
  if (old && record.wipLimit < old.wipLimit && afterCount > record.wipLimit) fail('Pause or return counted work before lowering the WIP limit.');
  if (afterCount > record.wipLimit && afterCount > beforeCount && changedCounted.some(value => !value.override)) {
    fail('Starting or resuming over the WIP limit requires an explicit override.');
  }
  const overrideSlots = record.entries.filter(value => countedExecutionStates.has(value.state) && value.override).length;
  if (afterCount > record.wipLimit && overrideSlots < afterCount - record.wipLimit) fail('Every WIP slot above the limit needs an explicit override.');
}
