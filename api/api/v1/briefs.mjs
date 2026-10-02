import { ValidationError, text } from '../shared/validate.mjs';

const fail = message => { throw new ValidationError(message); };
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Invalid brief fields.');
}
export function briefFields(action, input) {
  if (action === 'update') {
    shape(input, ['status']);
    if (!['accepted', 'rejected'].includes(input.status)) fail('Choose accepted or rejected for this brief revision.');
  } else {
    shape(input, ['subjectType', 'subjectId', 'sourceVersion', 'previousBriefId', 'content', 'status']);
    if (!['item', 'project'].includes(input.subjectType)) fail('A brief requires an item or project.');
    for (const value of [input.subjectId, ...(input.previousBriefId === null ? [] : [input.previousBriefId])]) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('Invalid brief source or previous revision ID.');
    }
    if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 1) fail('Brief sourceVersion must identify the observed source version.');
    if (input.status !== 'draft') fail('New brief revisions must start as unaccepted drafts.');
    const keys = ['outcome', 'context', 'scope', 'exclusions', 'nextAction', 'acceptanceChecks', 'missingInformation'];
    shape(input.content, keys);
    for (const key of keys) {
      if (typeof input.content[key] !== 'string' || !input.content[key].trim()) fail(`Brief ${key} is required; record unknowns explicitly.`);
      text(input.content[key], 4000, `Brief ${key}`);
    }
  }
  return structuredClone(input);
}

export async function validateBrief(record, old, lookup) {
  if (record.deleted) fail('Brief revisions are retained; reject an unaccepted draft instead.');
  if (old) {
    if (old.status !== 'draft') fail('This revision is already decided. Save edited content as a new draft revision.');
    return;
  }
  const subject = await lookup(record.subjectType, record.subjectId);
  if (!subject || subject.deleted) fail('Brief source is unavailable in this account.');
  if (record.previousBriefId) {
    const previous = await lookup('brief', record.previousBriefId);
    if (!previous || previous.deleted || previous.subjectType !== record.subjectType || previous.subjectId !== record.subjectId) fail('Previous brief revision must belong to the same source in this account.');
    if (record.sourceVersion !== previous.sourceVersion) fail('An edited revision must retain its source version. Generate a fresh template to use newer source facts.');
  } else if (record.sourceVersion !== subject.version) fail('Brief source changed. Keep a copy of your draft and review the latest source before saving a new revision.');
}
