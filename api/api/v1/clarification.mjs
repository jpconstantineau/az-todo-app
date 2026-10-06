import { validateRef, validateRefs } from './collection-model.mjs';
import { ValidationError, text as validateText } from '../shared/validate.mjs';
import { calendarDate } from './workflow.mjs';

const fail = message => { throw new ValidationError(message); };
const itemFields = ['title', 'status', 'collectionRefs', 'listId', 'projectId', 'waitingOn', 'reviewDate',
  'reviewDateUtc', 'startDate', 'startDateUtc', 'plannedDay'];
function shape(value, keys, label = 'clarification fields') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`Invalid ${label}.`);
}
function text(value, max = 4000) {
  if (typeof value !== 'string') fail('Clarification values must be text.');
  validateText(value, max, 'Clarification value');
}
function ref(value) { try { return validateRef(value); } catch (error) { fail(error.message); } }
function optionalRef(value) { if (value !== null) ref(value); }
function itemPatch(value, label) {
  shape(value, itemFields, label);
  if (!Object.keys(value).length) fail(`${label} cannot be empty.`);
  if ('title' in value) { text(value.title, 200); if (!value.title.trim()) fail('Title is required.'); }
  if ('status' in value && !['inbox', 'next', 'waiting', 'deferred', 'someday', 'reference', 'completed', 'dropped'].includes(value.status)) fail('Choose a valid item status.');
  if ('collectionRefs' in value) { try { validateRefs(value.collectionRefs); } catch (error) { fail(error.message); } }
  for (const name of ['listId', 'projectId']) if (name in value && value[name] !== null && (typeof value[name] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value[name]))) fail(`Choose a valid ${name}.`);
  if ('waitingOn' in value) text(value.waitingOn);
  for (const name of ['reviewDate', 'startDate', 'plannedDay']) if (name in value && value[name] !== null && value[name] !== '') calendarDate(value[name], name);
  for (const name of ['reviewDateUtc', 'startDateUtc']) if (name in value && value[name] !== null) fail(`${name} must be cleared by this decision.`);
}

export function clarificationFields(input) {
  shape(input, ['flowVersion', 'step', 'decision', 'proposal']);
  if (input.flowVersion !== 3) fail('Clarification flow version must be 3.');
  if (!['classify', 'complete', 'reversed'].includes(input.step)) fail('Invalid clarification step.');
  shape(input.proposal, ['view', 'mode', 'title', 'parentRef', 'search', 'status', 'waitingOn', 'reviewDate', 'startDate', 'plannedDay'], 'clarification proposal');
  if (!['classify', 'action', 'reference', 'someday'].includes(input.proposal.view) || !['file', 'parent'].includes(input.proposal.mode)) fail('Invalid clarification proposal mode.');
  text(input.proposal.title, 200); text(input.proposal.search, 200); text(input.proposal.waitingOn);
  optionalRef(input.proposal.parentRef);
  for (const name of ['reviewDate', 'startDate', 'plannedDay']) if (input.proposal[name]) calendarDate(input.proposal[name], name);
  const d = input.decision;
  if (d === null) {
    if (input.step !== 'classify') fail('Completed clarification requires a decision.');
    return structuredClone(input);
  }
  shape(d, ['type', 'destinationRef', 'containerRef', 'containerKind', 'parentRef', 'title', 'before', 'after']);
  if (!['file', 'item', 'convert', 'trash'].includes(d.type)) fail('Invalid clarification decision.');
  if (d.type === 'convert') {
    shape(d, ['type', 'containerRef', 'containerKind', 'parentRef', 'title'], 'clarification conversion decision');
    ref(d.containerRef); optionalRef(d.parentRef); text(d.title, 200);
    if (!d.title.trim() || !['project', 'list', 'checklist', 'area', 'role', 'initiative', 'program', 'reference'].includes(d.containerKind)) fail('Choose a supported container kind and title.');
  } else if (d.type === 'trash') {
    if (Object.keys(d).length !== 1) fail('Trash does not accept item or destination fields.');
  } else {
    shape(d, d.type === 'file' ? ['type', 'destinationRef', 'before', 'after'] : ['type', 'before', 'after'], 'clarification item decision');
    if (d.type === 'file') ref(d.destinationRef);
    itemPatch(d.before, 'clarification before fields'); itemPatch(d.after, 'clarification after fields');
    if (Object.keys(d.before).sort().join() !== Object.keys(d.after).sort().join()) fail('Before and after fields must describe the same item fields.');
  }
  return structuredClone(input);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exactMutation = (mutation, action, expectedVersion, fields) => mutation && mutation.action === action && mutation.expectedVersion === expectedVersion && (fields === undefined ? mutation.fields === undefined : same(mutation.fields, fields));

export function validateClarification(record, old, mutations, item) {
  if (old && old.flowVersion !== 3) fail('Replace the obsolete clarification before saving a v3 decision.');
  if (record.deleted) fail('Clarification history cannot be deleted.');
  const d = record.decision;
  if (record.step === 'classify' && !d) {
    if (mutations.length !== 1) fail('A blank clarification cannot change another record.');
    return;
  }
  if (record.step === 'reversed') {
    if (!old?.decision || !same(d, old.decision)) fail('Undo the latest clarification decision exactly.');
    if (d.type === 'convert') {
      const source = mutations.find(m => m.type === 'item' && m.id === record.id);
      const target = mutations.find(m => m.type === d.containerRef.type && m.id === d.containerRef.id);
      if (!item?.deleted || !exactMutation(source, 'restore', item.version) || !exactMutation(target, 'delete', 1) || mutations.length !== 3) fail('Undo conversion by restoring its source and deleting its unchanged empty container together.');
    } else if (d.type === 'trash') {
      const source = mutations.find(m => m.type === 'item' && m.id === record.id);
      if (!item?.deleted || !exactMutation(source, 'restore', item.version) || mutations.length !== 2) fail('Undo Trash by restoring its current tombstone.');
    } else {
      const source = mutations.find(m => m.type === 'item' && m.id === record.id);
      if (!item || item.deleted || Object.entries(d.after).some(([name, value]) => !same(item[name] ?? null, value)) ||
          !exactMutation(source, 'update', item.version, d.before) || mutations.length !== 2) fail('Undo only the unchanged fields from the latest clarification decision.');
    }
    return;
  }
  if (!item || item.deleted) fail('Clarification requires the current live source item.');
  if (d.type === 'convert') {
    const source = mutations.find(m => m.type === 'item' && m.id === record.id);
    const target = mutations.find(m => m.type === d.containerRef.type && m.id === d.containerRef.id);
    const type = d.containerKind === 'project' ? 'project' : 'list';
    if (d.containerRef.type !== type || !exactMutation(source, 'delete', item.version) || !target || target.action !== 'create' || target.expectedVersion !== 0 || mutations.length !== 3 ||
        target.fields.title !== d.title || !same(target.fields.parentRef ?? null, d.parentRef) || target.fields.workspaceId !== item.workspaceId ||
        (type === 'project' ? target.fields.status !== 'draft' || target.fields.outcome !== '' : target.fields.kind !== d.containerKind)) fail('Convert the source and create the selected container together.');
    return;
  }
  const source = mutations.find(m => m.type === 'item' && m.id === record.id);
  if (d.type === 'trash') {
    if (!exactMutation(source, 'delete', item.version) || mutations.length !== 2) fail('Save Trash and the source tombstone together.');
    return;
  }
  if (Object.entries(d.before).some(([name, value]) => !same(item[name] ?? null, value)) || !exactMutation(source, 'update', item.version, d.after) || mutations.length !== 2) fail('Item changes must match the accepted clarification exactly.');
  if (d.type === 'file') {
    if (record.step !== 'classify' || !d.after.collectionRefs?.some(candidate => same(candidate, d.destinationRef))) fail('Filing must add the selected destination without completing clarification.');
  } else if (record.step !== 'complete') fail('An item decision must complete clarification.');
}
