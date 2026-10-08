import { ValidationError, text } from '../shared/validate.mjs';
import { belongsTo } from './collection-model.mjs';

const fail = message => { throw new ValidationError(message); };
function object(value, allowed, field) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${field} must be an object.`);
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) fail(`${field}.${extra} is not supported.`);
}
function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(`${field} must contain 1–128 letters, numbers, underscores or hyphens.`);
  return value;
}
const sectionNames = ['purposePrinciples', 'desiredEvidence', 'organizationApproach', 'unresolvedQuestions'];
const candidateKinds = ['brainstorm', 'action', 'learning'];

export function projectPlanRevisionFields(action, input) {
  if (action !== 'create') fail('Project plan revisions are immutable. Accept a new revision instead.');
  object(input, ['projectId', 'sourceVersion', 'previousRevisionId', 'sections', 'candidates', 'mappings'], 'fields');
  const projectId = identifier(input.projectId, 'projectId');
  if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 1) fail('Plan sourceVersion must identify the observed project version.');
  const previousRevisionId = input.previousRevisionId === null ? null : identifier(input.previousRevisionId, 'previousRevisionId');
  object(input.sections, sectionNames, 'sections');
  const sections = {};
  for (const name of sectionNames) {
    if (typeof input.sections[name] !== 'string') fail(`${name} must be text.`);
    text(input.sections[name], 4000, name);
    sections[name] = input.sections[name];
  }
  if (!Array.isArray(input.candidates) || input.candidates.length > 50) fail('A project plan supports at most 50 candidate ideas.');
  const ids = new Set();
  const candidates = input.candidates.map((candidate, index) => {
    object(candidate, ['id', 'title', 'kind'], `candidates[${index}]`);
    const id = identifier(candidate.id, `candidates[${index}].id`);
    if (ids.has(id)) fail('Candidate IDs must be unique.');
    ids.add(id);
    if (typeof candidate.title !== 'string' || !candidate.title.trim()) fail('Every candidate idea needs a title.');
    text(candidate.title, 200, 'candidate title');
    if (!candidateKinds.includes(candidate.kind)) fail('Candidate kind must be brainstorm, action or learning.');
    return { id, title: candidate.title, kind: candidate.kind };
  });
  if (!candidates.length && !Object.values(sections).some(value => value.trim())) fail('Add planning context or a candidate idea before accepting.');
  if (!Array.isArray(input.mappings)) fail('Plan mappings must be an array.');
  const selected = candidates.filter(candidate => candidate.kind !== 'brainstorm');
  if (selected.length > 18) fail('Accept at most 18 actions or bounded learning steps at once.');
  const mappedCandidates = new Set(), mappedItems = new Set();
  const mappings = input.mappings.map((mapping, index) => {
    object(mapping, ['candidateId', 'itemId', 'kind'], `mappings[${index}]`);
    const candidateId = identifier(mapping.candidateId, `mappings[${index}].candidateId`);
    const itemId = identifier(mapping.itemId, `mappings[${index}].itemId`);
    const candidate = candidates.find(entry => entry.id === candidateId);
    if (!candidate || candidate.kind === 'brainstorm' || candidate.kind !== mapping.kind) fail('Every mapping must identify a selected candidate with the same kind.');
    if (mappedCandidates.has(candidateId) || mappedItems.has(itemId)) fail('Candidate and item mappings must be unique.');
    mappedCandidates.add(candidateId); mappedItems.add(itemId);
    return { candidateId, itemId, kind: mapping.kind };
  });
  if (mappings.length !== selected.length || selected.some(candidate => !mappedCandidates.has(candidate.id))) fail('Every selected candidate needs exactly one canonical item mapping.');
  return { projectId, sourceVersion: input.sourceVersion, previousRevisionId, sections, candidates, mappings };
}

export async function validateProjectPlanning(records, oldRecords, mutations, lookup) {
  const revisions = records.filter(record => record.type === 'projectPlanRevision');
  const headChanges = mutations.flatMap((mutation, index) => mutation.type === 'project' && Object.hasOwn(mutation.fields || {}, 'planningHeadId')
    ? [{ mutation, record: records[index], old: oldRecords[index]?.record }] : []);
  if (!revisions.length && !headChanges.length) return;
  if (revisions.length !== 1 || headChanges.length !== 1) fail('A project plan acceptance requires one paired project head and revision.');
  const revision = revisions[0], revisionMutation = mutations[records.indexOf(revision)], head = headChanges[0];
  if (revisionMutation.action !== 'create' || oldRecords[records.indexOf(revision)]) fail('Project plan revisions are immutable and create-only.');
  if (Object.keys(head.mutation.fields).length !== 1) fail('Plan acceptance may update only the project planning head.');
  if (head.mutation.action !== 'update' || head.record.deleted || head.record.planningHeadId !== revision.id || revision.projectId !== head.record.id) fail('The project head must advance to its paired planning revision.');
  if (revision.sourceVersion !== head.mutation.expectedVersion || revision.previousRevisionId !== (head.old?.planningHeadId || null)) fail('The project or its accepted plan changed. Review the latest plan before accepting again.');
  if (revision.previousRevisionId) {
    const previous = await lookup('projectPlanRevision', revision.previousRevisionId);
    if (!previous || previous.deleted || previous.projectId !== revision.projectId) fail('The previous plan head is unavailable or belongs to another project.');
  }
  const allowed = new Set([`project:${head.record.id}`, `projectPlanRevision:${revision.id}`, ...revision.mappings.map(mapping => `item:${mapping.itemId}`)]);
  if (mutations.some(mutation => !allowed.has(`${mutation.type}:${mutation.id}`))) fail('Project plan acceptance may contain only its head, revision and mapped actions.');
  const candidateById = new Map(revision.candidates.map(candidate => [candidate.id, candidate]));
  for (const mapping of revision.mappings) {
    const item = await lookup('item', mapping.itemId), candidate = candidateById.get(mapping.candidateId);
    if (!item || item.deleted || item.workspaceId !== head.record.workspaceId || item.status !== 'next' || item.projectId !== head.record.id || !belongsTo(item, head.record)) {
      fail('Every accepted plan mapping must resolve to a live project-member Next item in the same workspace.');
    }
    const mutation = mutations.find(entry => entry.type === 'item' && entry.id === mapping.itemId);
    const itemFields = ['title', 'description', 'originalText', 'sourceUrl', 'sourceTitle', 'selectedText', 'workspaceId', 'collectionRefs',
      'listId', 'projectId', 'plannedDay', 'plannedWeek', 'status', 'dueDateUtc', 'startDateUtc', 'reviewDateUtc', 'waitingOn', 'contexts',
      'areas', 'energy', 'timeRequired', 'priority', 'effortEstimate', 'referenceLinks'];
    if (mutation && (mutation.action !== 'create' || Object.keys(mutation.fields).some(field => !itemFields.includes(field)) ||
        item.title !== candidate.title || item.originalText !== candidate.title || item.description !== '' || item.listId !== null)) {
      fail('New accepted actions must exactly match their selected candidate without fabricated scheduling or targets.');
    }
  }
  for (const mutation of mutations.filter(entry => entry.type === 'item')) {
    if (!revision.mappings.some(mapping => mapping.itemId === mutation.id)) fail('Every action created with a plan must have an exact candidate mapping.');
  }
}
