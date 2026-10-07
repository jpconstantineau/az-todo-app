// A device snapshot is never an instruction to replay old writes.
const FORMAT = 'az-todo-device-export';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
import { readableBrief } from './briefs.js?v=4';
import { purgeWorkspaceState } from './workspaces.js?v=4';
const knownTypes = ['workspace', 'item', 'list', 'project', 'settings', 'clarification', 'review', 'reviewDecision', 'reviewReflection', 'brief', 'planPreference', 'dailyPlan', 'dailyPlanRevision'];
const recordFields = ['workspaceId', 'archived', 'id', 'type', 'accountId', 'version', 'createdUtc', 'updatedUtc', 'deleted', 'deletedUtc',
  'title', 'description', 'originalText', 'originalTextProvenance', 'sourceUrl', 'sourceTitle', 'selectedText', 'captureId', 'capturedAt', 'captureTimeZone',
  'collectionRefs', 'parentRef', 'kind', 'revisitDate', 'listId', 'projectId', 'plannedDay', 'plannedWeek', 'status', 'statusBeforeCompletion', 'completedUtc', 'nextAction',
  'dueDate', 'startDate', 'reviewDate', 'dueDateUtc', 'startDateUtc', 'reviewDateUtc',
  'workflowBeforeTransition', 'completionBeforeTransition', 'waitingOn', 'contexts', 'areas', 'energy', 'timeRequired',
  'priority', 'effortEstimate', 'referenceLinks', 'outcome', 'defaults', 'reviewKind', 'reviewDay', 'included', 'flowVersion', 'step', 'decision', 'proposal',
  'subjectType', 'subjectId', 'sourceVersion', 'previousBriefId', 'content',
  'previousReviewId', 'decisionHeads', 'decisionCount', 'reviewId', 'previousReflectionId', 'promptVersion', 'prompts', 'conclusion', 'followUpIds', 'sequence', 'index', 'choice', 'recordVersion', 'before', 'changes',
  'estimationMethod', 'planDay', 'actionIds', 'loadAssessment', 'carryoverDecisions', 'revisionHead', 'revisionCount', 'planId', 'operationKind', 'after', 'carryoverDecision', 'estimates'];

export const validateDeviceExport = value => validateExport(value);
export const validateAccountExport = value => validateExport(value, true);
function validateExport(value, server = false) {
  const require = (condition, message) => { if (!condition) throw new Error(`Invalid ${server ? 'account' : 'device'} export: ${message}`); };
  require(object(value) && value.format === (server ? 'az-todo-account-export' : FORMAT) && value.formatVersion === 1, 'unsupported format/version.');
  require(typeof value.accountId === 'string' && value.accountId.length > 0, 'accountId is required.');
  require(typeof value.exportedAt === 'string' && Number.isFinite(Date.parse(value.exportedAt)), 'exportedAt is required.');
  require(server ? value.scope === 'account' && value.source === 'server-history' :
    value.scope === 'device' && ['indexeddb', 'memory-recovery'].includes(value.source), 'invalid scope/source.');
  const state = value.state;
  require(object(state) && object(state.records) && Array.isArray(state.queue) && object(state.draft) && object(value.draft), 'records, queue and drafts are required.');
  require(Number.isSafeInteger(state.after) && state.after >= 0, 'change cursor must be a non-negative integer.');
  if (server) require(state.queue.length === 0 && Object.keys(state.draft).length === 0 && Object.keys(value.draft).length === 0,
    'a server snapshot cannot contain device drafts or pending saves.');
  const warnings = [];
  const clarification = (entry, path) => {
    require(entry.deleted !== true && entry.flowVersion === 3 && ['classify', 'complete', 'reversed'].includes(entry.step) &&
      (entry.decision === null || object(entry.decision)) && object(entry.proposal),
      `${path}: clarification must use the current flow version and shape.`);
    require(entry.step === 'classify' || entry.decision, `${path}: completed clarification needs a decision.`);
  };
  const reviewPointers = (entry, path, length, minimumCount = 0) => {
    require(!('decisions' in entry) && Number.isSafeInteger(entry.decisionCount) && entry.decisionCount >= minimumCount &&
      Array.isArray(entry.decisionHeads) && entry.decisionHeads.length <= 200 &&
      (length === undefined || entry.decisionHeads.length === length) &&
      entry.decisionHeads.every(id => id === null || typeof id === 'string' && id.length > 0),
    `${path}: review must use current history pointers.`);
  };
  const review = (entry, path, stored = false) => {
    require(!stored || entry.deleted !== true, `${path}: review history cannot be deleted.`);
    require(['daily', 'weekly', 'someday'].includes(entry.reviewKind) && /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewDay) &&
      Array.isArray(entry.included) && entry.included.length <= 200 && entry.included.every(ref => object(ref) &&
        ['item', 'project'].includes(ref.type) && typeof ref.id === 'string' && ref.id.length > 0), `${path}: invalid review shape.`);
    reviewPointers(entry, path, entry.included.length);
    require(entry.decisionCount !== 0 || entry.decisionHeads.every(id => id === null), `${path}: a new review must start with empty history pointers.`);
  };
  const reviewDecision = (entry, path, stored = false) => {
    require(!stored || entry.deleted !== true, `${path}: review decisions are immutable.`);
    require(typeof entry.reviewId === 'string' && entry.reviewId.length > 0 && Number.isSafeInteger(entry.sequence) && entry.sequence > 0 &&
      Number.isSafeInteger(entry.index) && entry.index >= 0 && Number.isSafeInteger(entry.recordVersion) && entry.recordVersion >= 0 &&
      ['retain', 'drop', 'defer', 'complete', 'next', 'unavailable', 'undo'].includes(entry.choice) && object(entry.before) && object(entry.changes),
    `${path}: invalid review decision shape.`);
  };
  const reviewReflection = (entry, path, stored = false) => {
    const promptNames = ['mentalSweep', 'calendarCheck', 'roleBalance', 'planReality'];
    require(!stored || entry.deleted !== true, `${path}: review reflections are immutable.`);
    require(typeof entry.reviewId === 'string' && entry.reviewId.length > 0 &&
      (entry.previousReflectionId === undefined || typeof entry.previousReflectionId === 'string' && entry.previousReflectionId.length > 0) &&
      entry.promptVersion === 1 && object(entry.prompts) && Object.keys(entry.prompts).length === promptNames.length &&
      promptNames.every(name => object(entry.prompts[name]) && ['unanswered', 'answered', 'skipped'].includes(entry.prompts[name].state) &&
        typeof entry.prompts[name].notes === 'string' && entry.prompts[name].notes.length <= 4000) &&
      typeof entry.conclusion === 'string' && entry.conclusion.length <= 4000 && Array.isArray(entry.followUpIds) && entry.followUpIds.length <= 50 &&
      entry.followUpIds.every(id => typeof id === 'string' && id.length > 0) && new Set(entry.followUpIds).size === entry.followUpIds.length,
    `${path}: invalid review reflection shape.`);
  };
  const unknown = (entry, allowed, path) => {
    for (const field of Object.keys(entry)) if (!allowed.includes(field)) warnings.push(`${path}.${field}: preserved, interpretation unsupported`);
  };
  const currentShape = (entry, path) => {
    if (['item', 'list', 'project', 'review', 'planPreference', 'dailyPlan', 'dailyPlanRevision'].includes(entry.type)) {
      require(typeof entry.workspaceId === 'string' && entry.workspaceId.length > 0, `${path}: workspaceId is required.`);
    }
    if (entry.type === 'item') {
      require(Array.isArray(entry.collectionRefs) && typeof entry.status === 'string' && entry.status.length > 0,
        `${path}: items require collectionRefs and status.`);
      require(entry.status !== 'waiting' || typeof entry.waitingOn === 'string' && entry.waitingOn.trim(), `${path}: waiting needs a subject.`);
      require(entry.status !== 'deferred' || entry.startDate || entry.startDateUtc, `${path}: deferred needs a start date.`);
      for (const name of ['due', 'start', 'review']) require(!(entry[`${name}Date`] && entry[`${name}DateUtc`]), `${path}: ${name} date is ambiguous.`);
    }
    if (entry.type === 'project') require(['draft', 'active', 'someday', 'completed'].includes(entry.status) &&
      (entry.status === 'draft' || typeof entry.outcome === 'string' && entry.outcome.trim()), `${path}: invalid project status/outcome.`);
    if (entry.type === 'planPreference') require(['none', 'tshirt', 'fibonacci'].includes(entry.estimationMethod), `${path}: invalid estimation method.`);
    if (entry.type === 'dailyPlan') require(/^\d{4}-\d{2}-\d{2}$/.test(entry.planDay) && Array.isArray(entry.actionIds) &&
      Array.isArray(entry.carryoverDecisions) && typeof entry.revisionHead === 'string' && Number.isSafeInteger(entry.revisionCount) && entry.revisionCount > 0,
    `${path}: invalid daily plan.`);
    if (entry.type === 'dailyPlanRevision') require(/^\d{4}-\d{2}-\d{2}$/.test(entry.planDay) && typeof entry.planId === 'string' &&
      Number.isSafeInteger(entry.sequence) && entry.sequence > 0 && object(entry.before) && object(entry.after) && Array.isArray(entry.estimates),
    `${path}: invalid daily plan revision.`);
  };
  unknown(value, ['format', 'formatVersion', 'exportedAt', 'scope', 'source', 'accountId', 'state', 'draft'], 'export');
  unknown(state, ['records', 'queue', 'after', 'draft', 'defaultSettings', 'undoEdit', 'workspaceDrafts', 'selectedWorkspace', 'workspaceMove', 'workspaceErasureNotice'], 'state');
  const draft = (entry, path) => {
    require(object(entry), `${path}: draft must be an object.`);
    unknown(entry, ['workspaceId', 'capture', 'edit', 'editOpen', 'defaults', 'defaultsOpen', 'clarification', 'brief', 'collectionUtility', 'day', 'navigation', 'review', 'extraction'], path);
    if (entry.capture) unknown(entry.capture, ['text', 'body', 'listId', 'newList', 'contexts', 'original'], `${path}.capture`);
    if (entry.edit && !object(entry.edit.initialFields)) warnings.push(`${path}.edit: missing saved baseline; preserved for recovery, editor restore unsupported`);
  };
  draft(value.draft, 'draft');
  draft(state.draft, 'state.draft');
  if (state.workspaceDrafts !== undefined) {
    require(object(state.workspaceDrafts), 'workspaceDrafts must be an object.');
    for (const [id, entry] of Object.entries(state.workspaceDrafts)) draft(entry, `state.workspaceDrafts.${id}`);
  }
  if (state.workspaceMove !== undefined) {
    const move = state.workspaceMove;
    require(object(move) && move.version === 1 && typeof move.id === 'string' && move.id.length > 0 &&
      ['detach', 'move', 'attach', 'complete'].includes(move.phase) && Number.isSafeInteger(move.step) && move.step >= 0 &&
      object(move.root) && ['list', 'project'].includes(move.root.type) && typeof move.root.id === 'string' &&
      typeof move.sourceWorkspaceId === 'string' && typeof move.destinationWorkspaceId === 'string' &&
      Array.isArray(move.entries) && move.entries.length > 20 && Array.isArray(move.skipped), 'workspaceMove has an invalid resumable move shape.');
    for (const entry of move.entries) require(object(entry) && ['list', 'project', 'item'].includes(entry.type) &&
      typeof entry.id === 'string' && object(entry.final), 'workspaceMove contains a malformed record.');
  }
  if (state.workspaceErasureNotice !== undefined) require(object(state.workspaceErasureNotice) &&
    typeof state.workspaceErasureNotice.workspaceId === 'string' && state.workspaceErasureNotice.workspaceId !== 'personal' &&
    Number.isFinite(Date.parse(state.workspaceErasureNotice.erasedUtc)), 'workspaceErasureNotice is invalid.');
  function record(entry, path) {
    require(object(entry) && entry.accountId === value.accountId, `${path}: record belongs to another account or has no owner.`);
    require(typeof entry.id === 'string' && entry.id.length > 0 && typeof entry.type === 'string' && entry.type.length > 0, `${path}: record identity is required.`);
    require(Number.isSafeInteger(entry.version) && entry.version > 0 && typeof entry.deleted === 'boolean', `${path}: version/deletion marker is required.`);
    currentShape(entry, path);
    if (entry.type === 'clarification') clarification(entry, path);
    if (entry.type === 'review') review(entry, path, true);
    if (entry.type === 'reviewDecision') reviewDecision(entry, path, true);
    if (entry.type === 'reviewReflection') reviewReflection(entry, path, true);
    if (!knownTypes.includes(entry.type)) warnings.push(`${path}: record type ${entry.type} preserved, interpretation unsupported`);
    unknown(entry, recordFields, path);
  }
  for (const [key, entry] of Object.entries(state.records)) {
    record(entry, `records.${key}`);
    require(key === `${entry.type}:${entry.id}`, `records.${key}: identity does not match its key.`);
  }
  const operations = new Set();
  for (const [index, entry] of state.queue.entries()) {
    const path = `queue[${index}]`, operation = entry?.operation;
    require(object(operation) && operation.apiVersion === 1 && operation.accountId === value.accountId, `${path}: operation account/version mismatch.`);
    require(typeof operation.operationId === 'string' && operation.operationId.length > 0 && !operations.has(operation.operationId), `${path}: missing or duplicate operation ID.`);
    operations.add(operation.operationId);
    require(Array.isArray(operation.mutations) && operation.mutations.length > 0, `${path}: mutations are required.`);
    for (const mutation of operation.mutations) {
      require(object(mutation) && typeof mutation.id === 'string' && typeof mutation.type === 'string' &&
        ['create', 'update', 'delete', 'restore'].includes(mutation.action) && Number.isSafeInteger(mutation.expectedVersion) &&
        (mutation.action === 'create' ? mutation.expectedVersion === 0 : mutation.expectedVersion > 0) &&
        (['delete', 'restore'].includes(mutation.action) ? mutation.fields === undefined : object(mutation.fields)), `${path}: malformed mutation.`);
      if (!knownTypes.includes(mutation.type)) warnings.push(`${path}: mutation type ${mutation.type} preserved, interpretation unsupported`);
      if (mutation.type === 'clarification') {
        require(['create', 'update'].includes(mutation.action) && object(mutation.fields), `${path}: clarification mutation must use the current shape.`);
        clarification(mutation.fields, `${path}.fields`);
      }
      if (mutation.type === 'review') {
        require(['create', 'update'].includes(mutation.action) && object(mutation.fields), `${path}: review mutation must use the current shape.`);
        if (mutation.action === 'create') review(mutation.fields, `${path}.fields`);
        else reviewPointers(mutation.fields, `${path}.fields`, undefined, 1);
      }
      if (mutation.type === 'reviewDecision') {
        require(mutation.action === 'create' && object(mutation.fields), `${path}: review decision mutation must create immutable history.`);
        reviewDecision(mutation.fields, `${path}.fields`);
      }
      if (mutation.type === 'reviewReflection') {
        require(mutation.action === 'create' && object(mutation.fields), `${path}: review reflection mutation must create immutable history.`);
        reviewReflection(mutation.fields, `${path}.fields`);
      }
      if (mutation.action === 'create') currentShape({ type: mutation.type, ...mutation.fields }, `${path}.fields`);
      if (mutation.fields) unknown(mutation.fields, recordFields, `${path}.fields`);
      unknown(mutation, ['id', 'type', 'action', 'expectedVersion', 'fields'], `${path}.mutation`);
    }
    if (entry.receipt !== undefined) {
      const receipt = entry.receipt;
      require(object(receipt) && receipt.accountId === value.accountId && receipt.operationId === operation.operationId &&
        receipt.apiVersion === 1 && ['conflict', 'committed'].includes(receipt.status) && Array.isArray(receipt.records), `${path}: receipt account/operation mismatch.`);
      for (const current of receipt.records) record(current, `${path}.receipt.records`);
      require(receipt.conflicts === undefined || Array.isArray(receipt.conflicts), `${path}: malformed conflicts.`);
      for (const conflict of receipt.conflicts || []) {
        require(object(conflict), `${path}: malformed conflict.`);
        if (conflict.current !== null) record(conflict.current, `${path}.receipt.conflicts.current`);
      }
    }
    unknown(operation, ['apiVersion', 'accountId', 'operationId', 'mutations'], `${path}.operation`);
    if (entry.workspaceMoveId !== undefined) require(typeof entry.workspaceMoveId === 'string' &&
      ['detach', 'move', 'attach'].includes(entry.workspaceMovePhase), `${path}: malformed collection move metadata.`);
    unknown(entry, ['operation', 'failure', 'receipt', 'workspaceMoveId', 'workspaceMovePhase'], path);
  }
  return { records: Object.keys(state.records).length, pendingOperations: state.queue.length, warnings };
}

export function deviceExport(accountId, state, draft, source = 'indexeddb') {
  const value = structuredClone({ format: FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(),
    scope: 'device', source, accountId, state, draft });
  validateDeviceExport(value);
  return value;
}

export async function accountExport(accountId, request, { signal, onProgress = () => {} } = {}) {
  const state = { records: {}, queue: [], draft: {}, after: 0 };
  let through, transferred = 0;
  do {
    signal?.throwIfAborted();
    const query = new URLSearchParams({ accountId, after: state.after, limit: 50 });
    if (through !== undefined) query.set('through', through);
    const page = await request(`export?${query}`);
    signal?.throwIfAborted();
    const invalid = () => { throw new Error('Invalid server export page. No file was downloaded; try again.'); };
    if (!object(page) || page.apiVersion !== 1 || page.accountId !== accountId || !Array.isArray(page.entries) ||
        !Number.isSafeInteger(page.highWater) || page.highWater < state.after ||
        (through !== undefined && page.highWater !== through)) invalid();
    through = page.highWater;
    // ponytail: bound browser memory/work; use a streaming export for larger histories.
    transferred += new TextEncoder().encode(JSON.stringify(page)).length;
    if (transferred > 50 * 1024 * 1024) throw new Error('Server history exceeds the 50 MiB browser export limit. No partial file was downloaded. Export a device copy and contact support for a full export.');
    for (const entry of page.entries) {
      if (!object(entry) || entry.accountId !== accountId || entry.apiVersion !== 1 || entry.sequence !== state.after + 1 ||
          !['committed', 'conflict'].includes(entry.status) || !Array.isArray(entry.records) ||
          (entry.status === 'conflict' && entry.records.length)) invalid();
      if (entry.erasedWorkspaces !== undefined && (!Array.isArray(entry.erasedWorkspaces) || entry.erasedWorkspaces.some(erasure =>
        typeof erasure?.workspaceId !== 'string' || erasure.workspaceId === 'personal' || !Number.isFinite(Date.parse(erasure.erasedUtc))))) invalid();
      for (const erasure of entry.erasedWorkspaces || []) purgeWorkspaceState(state, erasure.workspaceId, erasure.erasedUtc);
      for (const record of entry.records) {
        if (!object(record) || record.accountId !== accountId) invalid();
        const key = `${record.type}:${record.id}`;
        if (state.records[key] && record.version <= state.records[key].version) invalid();
        state.records[key] = record;
      }
      state.after = entry.sequence;
    }
    if (page.nextAfter !== state.after || state.after > through || page.hasMore !== (state.after < through) ||
        (page.hasMore && !page.entries.length)) invalid();
    onProgress(state.after, through);
  } while (state.after < through);
  const value = { format: 'az-todo-account-export', formatVersion: 1, exportedAt: new Date().toISOString(),
    scope: 'account', source: 'server-history', accountId, state, draft: {} };
  validateAccountExport(value);
  return value;
}

const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, letter => letter.toUpperCase());
function fields(value) {
  return Object.entries(value).map(([key, entry]) => `${label(key)}: ${typeof entry === 'string' ? entry : JSON.stringify(entry, null, 2)}`).join('\n');
}
function readableReflection(record, records) {
  const review = records[`review:${record.reviewId}`];
  const labels = { mentalSweep: 'Mental sweep', calendarCheck: 'Calendar check', roleBalance: 'Roles and outcomes', planReality: 'Plan and reality' };
  return [`Review: ${record.reviewId}`, `Review date: ${review?.reviewDay || 'Unavailable'}`,
    `Previous reflection: ${record.previousReflectionId || '(first snapshot)'}`,
    ...Object.entries(labels).map(([name, title]) => `${title}: ${record.prompts[name].state}\n${record.prompts[name].notes || '(no notes)'}`),
    `Conclusion: ${record.conclusion || '(none)'}`, `Follow-up action IDs: ${record.followUpIds.join(', ') || '(none)'}`].join('\n');
}

export function readableExport(value) {
  const server = value?.format === 'az-todo-account-export';
  validateExport(value, server);
  const lines = server ? ['To-Do server account copy', `Exported: ${value.exportedAt}`, `Account: ${value.accountId}`,
    `Server history cutoff: ${value.state.after}`,
    'All committed v1 records through this cutoff, including tombstones. Later changes and device drafts/pending saves are excluded.',
    'This file does not restore or submit work.'] : ['To-Do device copy', `Exported: ${value.exportedAt}`, `Account: ${value.accountId}`,
    `Last pulled change cursor: ${value.state.after}`, `Source: ${value.source}`,
    'Only data available on this device is included. Other devices or newer server changes may be missing.',
    'Pending saves and drafts below are NOT server-confirmed. This file does not restore or submit work.'];
  for (const [deleted, heading] of [[false, 'SERVER-CONFIRMED RECORD SNAPSHOTS'], [true, 'DELETED RECORD SNAPSHOTS (not active tasks)']]) {
    lines.push('', heading);
    const records = Object.values(value.state.records).filter(record => record.deleted === deleted);
    if (!records.length) lines.push('(none)');
    for (const record of records) lines.push('', `${record.type}: ${record.title ?? record.id}`,
      record.type === 'brief' && record.content ? readableBrief(record) : record.type === 'reviewReflection' ? readableReflection(record, value.state.records) : fields(record));
  }
  if (server) return lines.join('\n') + '\n';
  lines.push('', 'PENDING SAVES (not server-confirmed)');
  if (!value.state.queue.length) lines.push('(none)');
  for (const entry of value.state.queue) {
    lines.push('', `Operation: ${entry.operation.operationId}`, `State: ${entry.failure || 'Pending acknowledgement'}`);
    for (const mutation of entry.operation.mutations) {
      lines.push(`${mutation.action} ${mutation.type}:${mutation.id} at expected version ${mutation.expectedVersion}`, fields(mutation.fields || {}));
    }
    if (entry.receipt) lines.push('Conflict/receipt (proposed and server versions retained):', JSON.stringify(entry.receipt, null, 2));
  }
  lines.push('', 'CURRENT FORM DRAFT (not submitted)', JSON.stringify(value.draft, null, 2),
    '', 'SAVED DEVICE DRAFT (may differ from current form)', JSON.stringify(value.state.draft, null, 2));
  if (value.state.workspaceDrafts) lines.push('', 'WORKSPACE DRAFTS (not submitted)', JSON.stringify(value.state.workspaceDrafts, null, 2));
  if (value.state.undoEdit) lines.push('', 'LAST DEVICE EDIT RECOVERY (not a restore instruction)', JSON.stringify(value.state.undoEdit, null, 2));
  if (value.state.workspaceMove) lines.push('', 'RESUMABLE COLLECTION MOVE (not server-confirmed until complete)', JSON.stringify(value.state.workspaceMove, null, 2));
  if (value.state.defaultSettings) lines.push('', 'CACHED DEFAULTS', JSON.stringify(value.state.defaultSettings, null, 2));
  return lines.join('\n') + '\n';
}
