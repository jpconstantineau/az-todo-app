import { ValidationError } from '../shared/validate.mjs';

const steps = ['outcome', 'nextAction', 'missingFacts', 'disposition'];
const fail = message => { throw new ValidationError(message); };
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Invalid clarification fields.');
}
function text(value, max = 4000) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`Clarification text must be at most ${max} characters.`);
}
export function clarificationFields(input) {
  shape(input, ['step', 'answers', 'proposal']);
  if (!Number.isInteger(input.step) || input.step < 0 || input.step > steps.length) fail('Clarification step must be 0–4.');
  shape(input.answers, steps);
  for (const [index, name] of steps.entries()) {
    const answer = input.answers[name];
    if (index >= input.step) { if (answer !== undefined) fail('Future clarification answers must remain unknown.'); continue; }
    shape(answer, ['decision', 'value']);
    if (!['accepted', 'skipped'].includes(answer.decision)) fail('Choose accepted or skipped for each answered question.');
    if (answer.decision === 'skipped') {
      if (answer.value !== null) fail('Skipped answers must remain unknown.');
    } else if (name === 'disposition') {
      disposition(answer.value);
    } else {
      text(answer.value, name === 'nextAction' ? 200 : 4000);
      if (!answer.value.trim()) fail('Supply an answer or skip the question.');
    }
  }
  shape(input.proposal, ['text', 'status', 'waitingOn', 'reviewDate', 'startDate']);
  text(input.proposal.text);
  disposition(input.proposal, true);
  return structuredClone(input);
}
function disposition(value, draft = false) {
  shape(value, draft ? ['text', 'status', 'waitingOn', 'reviewDate', 'startDate'] : ['status', 'waitingOn', 'reviewDate', 'startDate']);
  if (!['', 'keep', 'next', 'waiting', 'deferred'].includes(value.status) || (!draft && !value.status)) fail('Choose a clarification disposition.');
  text(value.waitingOn);
  for (const name of ['reviewDate', 'startDate']) {
    const date = value[name];
    if (typeof date !== 'string' || date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) fail('Choose a valid clarification calendar date.');
  }
  if (!draft && value.status === 'waiting' && (!value.waitingOn.trim() || !value.reviewDate)) fail('Waiting needs a dependency and review date.');
  if (!draft && value.status === 'deferred' && !value.startDate) fail('Deferred needs a start date.');
}
