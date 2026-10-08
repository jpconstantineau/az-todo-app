const sectionNames = ['purposePrinciples', 'desiredEvidence', 'organizationApproach', 'unresolvedQuestions'];
const kinds = ['brainstorm', 'action', 'learning'];
const clone = value => structuredClone(value);
const projectMember = (item, project) => item?.projectId === project.id &&
  (item.collectionRefs || []).some(ref => ref.type === 'project' && ref.id === project.id);

export function emptyProjectPlan(project) {
  return { version: 1, projectId: project.id, sourceVersion: project.version, previousRevisionId: project.planningHeadId || null,
    sections: Object.fromEntries(sectionNames.map(name => [name, ''])), candidates: [] };
}

export function acceptedProjectPlan(project, records) {
  if (!project?.planningHeadId || project.localState) return null;
  const revision = records[`projectPlanRevision:${project.planningHeadId}`];
  return revision && !revision.deleted && !revision.localState && revision.projectId === project.id ? revision : null;
}

export function draftFromAccepted(project, records) {
  const revision = acceptedProjectPlan(project, records);
  if (!revision) return emptyProjectPlan(project);
  const mapping = new Map(revision.mappings.map(entry => [entry.candidateId, entry.itemId]));
  return { version: 1, projectId: project.id, sourceVersion: project.version, previousRevisionId: revision.id,
    sections: clone(revision.sections), candidates: revision.candidates.map(candidate => {
      const itemId = mapping.get(candidate.id), item = itemId && records[`item:${itemId}`];
      return { ...clone(candidate), ...(item && !item.deleted && item.status === 'next' && item.workspaceId === project.workspaceId && projectMember(item, project) ? { itemId } : {}) };
    }) };
}

export function validateProjectPlanDraft(draft) {
  if (!draft || draft.version !== 1 || typeof draft.projectId !== 'string' || !Number.isSafeInteger(draft.sourceVersion) || draft.sourceVersion < 1) throw new Error('This project planning draft is invalid.');
  if (!draft.sections || sectionNames.some(name => typeof draft.sections[name] !== 'string' || draft.sections[name].length > 4000)) throw new Error('Planning sections are limited to 4,000 characters each.');
  if (!Array.isArray(draft.candidates) || draft.candidates.length > 50) throw new Error('A project plan supports at most 50 candidate ideas.');
  const ids = new Set();
  for (const candidate of draft.candidates) {
    if (!candidate || typeof candidate.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.id) || ids.has(candidate.id)) throw new Error('Candidate ideas need unique stable IDs.');
    ids.add(candidate.id);
    if (typeof candidate.title !== 'string' || !candidate.title.trim() || candidate.title.length > 200) throw new Error('Every candidate idea needs a title of at most 200 characters.');
    if (!kinds.includes(candidate.kind)) throw new Error('Choose brainstorming, Action or Bounded learning step for every candidate.');
    if (candidate.itemId !== undefined && (typeof candidate.itemId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.itemId))) throw new Error('A candidate item mapping is invalid.');
  }
  const selected = draft.candidates.filter(candidate => candidate.kind !== 'brainstorm');
  if (selected.length > 18) throw new Error('Select at most 18 actions or bounded learning steps per acceptance.');
  if (!draft.candidates.length && !Object.values(draft.sections).some(value => value.trim())) throw new Error('Add planning context or a candidate idea before accepting.');
  return draft;
}

export function projectPlanMutations(project, input, records, createId = () => crypto.randomUUID()) {
  const draft = validateProjectPlanDraft(clone(input));
  if (project.deleted || project.localState || project.id !== draft.projectId || project.version !== draft.sourceVersion || (project.planningHeadId || null) !== (draft.previousRevisionId || null)) {
    throw new Error('This project or accepted plan changed. Recover the draft against the latest project before accepting.');
  }
  const revisionId = createId(), mappings = [], items = [];
  for (const candidate of draft.candidates.filter(entry => entry.kind !== 'brainstorm')) {
    let itemId = candidate.itemId, item = itemId && records[`item:${itemId}`];
    if (!item || item.deleted || item.workspaceId !== project.workspaceId || item.status !== 'next' || !projectMember(item, project)) {
      itemId = createId();
      items.push({ type: 'item', id: itemId, action: 'create', expectedVersion: 0, fields: {
        title: candidate.title, description: '', originalText: candidate.title, workspaceId: project.workspaceId,
        collectionRefs: [{ type: 'project', id: project.id }], listId: null, projectId: project.id, status: 'next'
      } });
    }
    mappings.push({ candidateId: candidate.id, itemId, kind: candidate.kind });
  }
  return [
    { type: 'project', id: project.id, action: 'update', expectedVersion: project.version, fields: { planningHeadId: revisionId } },
    { type: 'projectPlanRevision', id: revisionId, action: 'create', expectedVersion: 0, fields: {
      projectId: project.id, sourceVersion: project.version, previousRevisionId: project.planningHeadId || null,
      sections: clone(draft.sections), candidates: draft.candidates.map(({ id, title, kind }) => ({ id, title, kind })), mappings
    } }, ...items
  ];
}

export function validateProjectPlanOperation(mutations, records, proposed) {
  const revisions = mutations.filter(mutation => mutation.type === 'projectPlanRevision');
  const heads = mutations.filter(mutation => mutation.type === 'project' && Object.hasOwn(mutation.fields || {}, 'planningHeadId'));
  if (!revisions.length && !heads.length) return;
  if (revisions.length !== 1 || heads.length !== 1 || revisions[0].action !== 'create' || heads[0].action !== 'update') throw new Error('A project plan acceptance needs one paired head and immutable revision.');
  const revision = proposed[`projectPlanRevision:${revisions[0].id}`], project = proposed[`project:${heads[0].id}`], old = records[`project:${heads[0].id}`];
  validateProjectPlanDraft({ version: 1, projectId: revision.projectId, sourceVersion: revision.sourceVersion, previousRevisionId: revision.previousRevisionId,
    sections: revision.sections, candidates: revision.candidates });
  if (!old || project.planningHeadId !== revision.id || revision.projectId !== project.id || revision.sourceVersion !== heads[0].expectedVersion || revision.previousRevisionId !== (old.planningHeadId || null)) throw new Error('The project plan head and revision do not match.');
  if (Object.keys(heads[0].fields).length !== 1) throw new Error('Plan acceptance may update only the project planning head.');
  const selected = revision.candidates.filter(candidate => candidate.kind !== 'brainstorm');
  const mapped = new Map(revision.mappings.map(mapping => [mapping.candidateId, mapping])), mappedItems = new Set(revision.mappings.map(mapping => mapping.itemId));
  if (mapped.size !== selected.length || mappedItems.size !== revision.mappings.length || selected.some(candidate => mapped.get(candidate.id)?.kind !== candidate.kind)) throw new Error('Every selected candidate needs one exact item mapping.');
  const allowed = new Set([`project:${project.id}`, `projectPlanRevision:${revision.id}`, ...revision.mappings.map(mapping => `item:${mapping.itemId}`)]);
  if (mutations.some(mutation => !allowed.has(`${mutation.type}:${mutation.id}`))) throw new Error('Plan acceptance may contain only its project head, revision and mapped actions.');
  for (const mapping of revision.mappings) {
    const item = proposed[`item:${mapping.itemId}`];
    if (!item || item.deleted || item.workspaceId !== project.workspaceId || item.status !== 'next' || !projectMember(item, project)) throw new Error('Every accepted candidate must map to a live project-member Next item.');
    const mutation = mutations.find(entry => entry.type === 'item' && entry.id === mapping.itemId);
    const candidate = revision.candidates.find(entry => entry.id === mapping.candidateId);
    const itemFields = ['title', 'description', 'originalText', 'sourceUrl', 'sourceTitle', 'selectedText', 'workspaceId', 'collectionRefs',
      'listId', 'projectId', 'plannedDay', 'plannedWeek', 'status', 'dueDateUtc', 'startDateUtc', 'reviewDateUtc', 'waitingOn', 'contexts',
      'areas', 'energy', 'timeRequired', 'priority', 'effortEstimate', 'referenceLinks'];
    if (mutation && (mutation.action !== 'create' || Object.keys(mutation.fields).some(field => !itemFields.includes(field)) ||
        item.title !== candidate.title || item.originalText !== candidate.title || item.description !== '' || item.listId !== null)) {
      throw new Error('New accepted actions must exactly match their selected candidate without fabricated scheduling or targets.');
    }
  }
}

export function acceptedPlanBriefContext(subject, records) {
  const project = subject.type === 'project' ? subject : subject.projectId ? records[`project:${subject.projectId}`] : null;
  const revision = acceptedProjectPlan(project, records);
  if (!project || project.deleted || !revision) return { context: [], missing: [] };
  const context = [`Accepted project plan provenance: project:${project.id} at version ${project.version}; projectPlanRevision:${revision.id} at version ${revision.version}.`];
  if (revision.sections.purposePrinciples.trim()) context.push(`Accepted purpose & principles: ${revision.sections.purposePrinciples}`);
  if (revision.sections.desiredEvidence.trim()) context.push(`Accepted desired evidence: ${revision.sections.desiredEvidence}`);
  if (revision.sections.organizationApproach.trim()) context.push(`Accepted organization / approach: ${revision.sections.organizationApproach}`);
  const candidates = new Map(revision.candidates.map(candidate => [candidate.id, candidate]));
  for (const mapping of revision.mappings) {
    const item = records[`item:${mapping.itemId}`], candidate = candidates.get(mapping.candidateId);
    const current = item && !item.deleted && item.status === 'next' && item.workspaceId === project.workspaceId && projectMember(item, project);
    context.push(current
      ? `Current accepted-plan ${mapping.kind === 'learning' ? 'bounded learning step' : 'action'}: ${item.title} (item:${item.id} at version ${item.version}).`
      : `Accepted-plan history: ${candidate?.title || mapping.candidateId} mapped to item:${mapping.itemId}; it is no longer a current project Next action.`);
  }
  const missing = revision.sections.unresolvedQuestions.trim() ? [`Accepted unresolved questions: ${revision.sections.unresolvedQuestions}`] : [];
  return { context, missing };
}

export function recoverProjectPlanDraft(operation, project, records) {
  const revision = operation?.mutations?.find(mutation => mutation.type === 'projectPlanRevision')?.fields;
  if (!revision || !project || project.deleted) throw new Error('The pending project plan cannot be recovered against an unavailable project.');
  const mapping = new Map(revision.mappings.map(entry => [entry.candidateId, entry.itemId]));
  return { version: 1, projectId: project.id, sourceVersion: project.version, previousRevisionId: project.planningHeadId || null,
    sections: clone(revision.sections), candidates: revision.candidates.map(candidate => {
      const itemId = mapping.get(candidate.id), item = itemId && records[`item:${itemId}`];
      return { ...clone(candidate), ...(item && !item.deleted && item.status === 'next' && item.workspaceId === project.workspaceId && projectMember(item, project) ? { itemId } : {}) };
    }) };
}
