import { validateRefs } from './collection-model.mjs';
import { ValidationError, text as validateText } from '../shared/validate.mjs';
import { calendarDate } from './workflow.mjs';

const steps = ['outcome', 'nextAction', 'missingFacts', 'disposition'];
const fail = message => { throw new ValidationError(message); };
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Invalid clarification fields.');
}
function text(value, max = 4000) {
  if (typeof value !== 'string') fail('Clarification answers must be text.');
  validateText(value, max, 'Clarification answer'); // Validate without trimming the supplied wording.
}
export function clarificationFields(input) {
  if (input?.flowVersion === 2) return branchingFields(input);
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

const flowKeys = ['text', 'choice', 'projectId', 'projectTitle', 'outcome', 'waitingOn', 'reviewDate', 'startDate', 'plannedDay', 'listId', 'notes'];
const pathFor = answers => ['actionable', ...(answers.actionable === 'yes' ? ['nextAction', 'project', 'twoMinutes'] : []), 'disposition', ...(answers.disposition?.choice === 'trash' ? [] : ['organize']), 'summary', 'complete'];
const choose = (value, options) => { if (!options.includes(value)) fail('Choose a valid clarification decision.'); };
const nonblank = (value, max) => { text(value, max); if (!value.trim()) fail('Supply an answer before continuing.'); };
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('Choose a valid destination.'); };
function dates(value) {
  for (const key of ['reviewDate', 'startDate', 'plannedDay']) if (key in value) {
    if (typeof value[key] !== 'string') fail('Choose a valid clarification calendar date.');
    if (value[key]) calendarDate(value[key], key);
  }
}
function branchingFields(input) {
  shape(input, ['flowVersion', 'step', 'answers', 'proposal']);
  shape(input.answers, ['actionable', 'nextAction', 'project', 'twoMinutes', 'disposition', 'organize']);
  const a = input.answers, path = pathFor(a), index = path.indexOf(input.step);
  if (index < 0) fail('Invalid clarification step.');
  const answered = path.slice(0, Math.min(index, path.indexOf('summary')));
  if (Object.keys(a).length !== answered.length || answered.some(key => !(key in a))) fail('Answers must match the chosen clarification branch and step.');
  for (const key of answered) {
    const value = a[key];
    if (['actionable', 'twoMinutes'].includes(key)) choose(value, ['yes', 'no']);
    if (key === 'nextAction') nonblank(value, 200);
    if (key === 'project') {
      shape(value, ['choice', 'projectId', 'projectTitle', 'outcome']);
      choose(value.choice, ['keep', 'none', 'existing', 'new']);
      for (const name of ['projectId', 'projectTitle', 'outcome']) text(value[name], name === 'projectId' ? 128 : name === 'projectTitle' ? 200 : 4000);
      if (value.choice === 'existing') id(value.projectId);
      else if (value.projectId) fail('Only an existing-project choice supplies a project ID.');
      if (value.choice === 'new') { nonblank(value.projectTitle, 200); nonblank(value.outcome, 4000); }
      else if (value.projectTitle || value.outcome) fail('Only a new project supplies its title and outcome.');
    }
    if (key === 'disposition') {
      shape(value, ['choice', 'waitingOn', 'reviewDate', 'startDate', 'plannedDay']);
      choose(value.choice, a.actionable === 'no' ? ['someday', 'reference', 'trash'] : ['next', 'waiting', 'planned', 'deferred', 'dropped', ...(a.twoMinutes === 'yes' ? ['completed'] : [])]);
      text(value.waitingOn); dates(value);
      if (value.choice === 'waiting') nonblank(value.waitingOn, 4000);
      else if (value.waitingOn) fail('Only Waiting supplies a dependency.');
      if (!['waiting', 'someday'].includes(value.choice) && value.reviewDate) fail('Review date does not apply to this decision.');
      if (value.choice === 'deferred' ? !value.startDate : value.startDate) fail('Only Deferred requires a start date.');
      if (value.choice === 'planned' ? !value.plannedDay : value.plannedDay) fail('Only Plan for a day requires a planned day.');
    }
    if (key === 'organize') {
      shape(value, ['text', 'listId', 'notes', 'collectionRefs', 'projectId']);
      if ('collectionRefs' in value) { try { validateRefs(value.collectionRefs); } catch (error) { fail(error.message); } if (value.projectId !== '') id(value.projectId); } nonblank(value.text, 200); text(value.notes);
      if (value.listId !== '') id(value.listId);
    }
  }
  shape(input.proposal, [...flowKeys, 'collectionRefs']);
  if ('collectionRefs' in input.proposal) { try { validateRefs(input.proposal.collectionRefs); } catch (error) { fail(error.message); } }
  for (const name of flowKeys) text(input.proposal[name], ['text', 'projectTitle'].includes(name) ? 200 : ['projectId', 'listId'].includes(name) ? 128 : 4000);
  dates(input.proposal);
  return structuredClone(input);
}

// The accepted v2 decision and the exact item/project changes are one operation.
export function validateClarification(record, old, mutations, item) {
  if (old && (old.flowVersion || 1) !== (record.flowVersion || 1)) fail('Keep this clarification in its original flow version.');
  if (record.flowVersion !== 2) return;
  if (record.deleted) fail('Clarification history cannot be deleted.');
  if (old?.step === 'complete') fail('This clarification is already complete.');
  const mutation = mutations.find(m => m.type === 'item' && m.id === record.id);
  if (record.step !== 'complete') {
    if (mutation) fail('Apply task changes only with the final clarification decision.');
    return;
  }
  if (!item || item.deleted || !mutation || mutation.expectedVersion !== item.version) fail('Apply clarification to the current live item.');
  const a = record.answers, d = a.disposition;
  if (d.choice === 'trash') {
    if (mutation.action !== 'delete' || mutations.length !== 2) fail('Save the Trash decision and item deletion together.');
    return;
  }
  const expected = { title: a.organize.text, listId: a.organize.listId || null, status: d.choice === 'planned' ? 'next' : d.choice };
  if (a.organize.collectionRefs) Object.assign(expected, { collectionRefs: a.organize.collectionRefs, projectId: a.organize.projectId || null });
  if (!a.organize.collectionRefs && a.project?.choice === 'none') expected.projectId = null;
  if (!a.organize.collectionRefs && a.project?.choice === 'existing') expected.projectId = a.project.projectId;
  if (d.choice === 'waiting') Object.assign(expected, { waitingOn: d.waitingOn, ...(d.reviewDate ? { reviewDate: d.reviewDate, reviewDateUtc: null } : {}) });
  if (d.choice === 'someday') Object.assign(expected, { reviewDate: d.reviewDate || null, reviewDateUtc: null });
  if (d.choice === 'deferred') Object.assign(expected, { startDate: d.startDate, startDateUtc: null });
  if (d.choice === 'planned') expected.plannedDay = d.plannedDay;
  if (a.project?.choice === 'new') {
    const project = mutations.find(m => m.type === 'project' && m.id === mutation.fields?.projectId);
    if (!project || project.action !== 'create' || project.fields.title !== a.project.projectTitle || project.fields.outcome !== a.project.outcome ||
      (project.fields.workspaceId || 'personal') !== (item.workspaceId || 'personal') || mutations.length !== 3) fail('Create and assign the proposed project with the final decision.');
    expected.projectId = project.id;
    if (expected.collectionRefs) expected.collectionRefs = [...expected.collectionRefs, { type: 'project', id: project.id }];
  } else if (mutations.length !== 2) fail('Save only the item and its final clarification decision.');
  if (mutation.action !== 'update' || Object.keys(mutation.fields).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([name, value]) => JSON.stringify(mutation.fields[name]) !== JSON.stringify(value))) fail('Item changes must match the accepted clarification exactly.');
}
function disposition(value, draft = false) {
  shape(value, draft ? ['text', 'status', 'waitingOn', 'reviewDate', 'startDate'] : ['status', 'waitingOn', 'reviewDate', 'startDate']);
  if (!['', 'keep', 'next', 'waiting', 'deferred', 'someday', 'reference', 'completed', 'dropped'].includes(value.status) || (!draft && !value.status)) fail('Choose a clarification disposition.');
  text(value.waitingOn);
  for (const name of ['reviewDate', 'startDate']) {
    const date = value[name];
    if (typeof date !== 'string') fail('Choose a valid clarification calendar date.');
    if (date) calendarDate(date, name);
  }
  if (!draft && value.status === 'waiting' && !value.waitingOn.trim()) fail('Waiting needs a dependency.');
  if (!draft && value.status === 'deferred' && !value.startDate) fail('Deferred needs a start date.');
}
