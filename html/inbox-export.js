// A device snapshot is never an instruction to replay old writes.
const FORMAT = 'az-todo-device-export';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownTypes = ['item', 'list', 'project', 'settings', 'review'];
const recordFields = ['id', 'type', 'accountId', 'version', 'createdUtc', 'updatedUtc', 'deleted', 'deletedUtc',
  'title', 'description', 'originalText', 'originalTextProvenance', 'sourceUrl', 'sourceTitle', 'selectedText',
  'listId', 'projectId', 'plannedDay', 'status', 'statusBeforeCompletion', 'completedUtc', 'nextAction',
  'dueDate', 'startDate', 'reviewDate', 'dueDateUtc', 'startDateUtc', 'reviewDateUtc',
  'workflowBeforeTransition', 'completionBeforeTransition', 'waitingOn', 'contexts', 'areas', 'energy', 'timeRequired',
  'priority', 'referenceLinks', 'outcome', 'defaults', 'reviewKind', 'reviewDay', 'included', 'decisions'];

export function validateDeviceExport(value) {
  const require = (condition, message) => { if (!condition) throw new Error(`Invalid device export: ${message}`); };
  require(object(value) && value.format === FORMAT && value.formatVersion === 1, 'unsupported format/version.');
  require(typeof value.accountId === 'string' && value.accountId.length > 0, 'accountId is required.');
  require(typeof value.exportedAt === 'string' && Number.isFinite(Date.parse(value.exportedAt)), 'exportedAt is required.');
  require(value.scope === 'device' && ['indexeddb', 'memory-recovery'].includes(value.source), 'device scope/source is required.');
  const state = value.state;
  require(object(state) && object(state.records) && Array.isArray(state.queue) && object(state.draft) && object(value.draft), 'records, queue and drafts are required.');
  require(Number.isSafeInteger(state.after) && state.after >= 0, 'change cursor must be a non-negative integer.');
  const warnings = [];
  const unknown = (entry, allowed, path) => {
    for (const field of Object.keys(entry)) if (!allowed.includes(field)) warnings.push(`${path}.${field}: preserved, interpretation unsupported`);
  };
  unknown(value, ['format', 'formatVersion', 'exportedAt', 'scope', 'source', 'accountId', 'state', 'draft'], 'export');
  unknown(state, ['records', 'queue', 'after', 'draft', 'defaultSettings', 'legacyDefaults'], 'state');
  function record(entry, path) {
    require(object(entry) && entry.accountId === value.accountId, `${path}: record belongs to another account or has no owner.`);
    require(typeof entry.id === 'string' && entry.id.length > 0 && typeof entry.type === 'string' && entry.type.length > 0, `${path}: record identity is required.`);
    require(Number.isSafeInteger(entry.version) && entry.version > 0 && typeof entry.deleted === 'boolean', `${path}: version/deletion marker is required.`);
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
        ['create', 'update', 'delete'].includes(mutation.action) && Number.isSafeInteger(mutation.expectedVersion) &&
        (mutation.action === 'create' ? mutation.expectedVersion === 0 : mutation.expectedVersion > 0) &&
        (mutation.action === 'delete' ? mutation.fields === undefined : object(mutation.fields)), `${path}: malformed mutation.`);
      if (!knownTypes.includes(mutation.type)) warnings.push(`${path}: mutation type ${mutation.type} preserved, interpretation unsupported`);
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
    unknown(entry, ['operation', 'failure', 'receipt'], path);
  }
  return { records: Object.keys(state.records).length, pendingOperations: state.queue.length, warnings };
}

export function deviceExport(accountId, state, draft, source = 'indexeddb') {
  const value = structuredClone({ format: FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(),
    scope: 'device', source, accountId, state, draft });
  validateDeviceExport(value);
  return value;
}

const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, letter => letter.toUpperCase());
function fields(value) {
  return Object.entries(value).map(([key, entry]) => `${label(key)}: ${typeof entry === 'string' ? entry : JSON.stringify(entry, null, 2)}`).join('\n');
}

export function readableExport(value) {
  validateDeviceExport(value);
  const lines = ['To-Do device copy', `Exported: ${value.exportedAt}`, `Account: ${value.accountId}`,
    `Last pulled change cursor: ${value.state.after}`, `Source: ${value.source}`,
    'Only data available on this device is included. Other devices or newer server changes may be missing.',
    'Pending saves and drafts below are NOT server-confirmed. This file does not restore or submit work.'];
  for (const [deleted, heading] of [[false, 'SERVER-CONFIRMED RECORD SNAPSHOTS'], [true, 'DELETED RECORD SNAPSHOTS (not active tasks)']]) {
    lines.push('', heading);
    const records = Object.values(value.state.records).filter(record => record.deleted === deleted);
    if (!records.length) lines.push('(none)');
    for (const record of records) lines.push('', `${record.type}: ${record.title ?? record.id}`, fields(record));
  }
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
  if (value.state.defaultSettings || value.state.legacyDefaults) lines.push('', 'CACHED DEFAULTS',
    JSON.stringify({ defaultSettings: value.state.defaultSettings, legacyDefaults: value.state.legacyDefaults }, null, 2));
  return lines.join('\n') + '\n';
}
