import { createHash } from "node:crypto";
import { ValidationError, text, cleanTag, utcDate } from "../shared/validate.mjs";
import { defaultSettings } from "../shared/defaults.mjs";
import { calendarDate } from "./workflow.mjs";
import { reviewFields, reviewDecisionFields } from "./reviews.mjs";
import { clarificationFields } from "./clarification.mjs";
import { briefFields } from "./briefs.mjs";

export const MAX_BODY_BYTES = 65536;
export const MAX_RECORD_BYTES = 32768;
export const partition = accountId => [accountId, "sync", "v1"];
export const recordId = (type, id) => `record:${type}:${id}`;
export const document = (accountId, id, fields) => ({
  ...fields, id, UserID: accountId, ObjectType: "sync", ObjectID: "v1", ttl: -1
});
export const bytes = value => Buffer.byteLength(JSON.stringify(value));
export const canonical = value => JSON.stringify(value, function (key, entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry;
});
export const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

export function object(value, allowed, field) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new ValidationError(`${field} must be an object.`);
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new ValidationError(`${field}.${extra} is not supported.`);
}
export function identifier(value, field = "id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ValidationError(`${field} must contain 1–128 letters, numbers, underscores or hyphens.`);
  }
  return value;
}
export function recordType(value) {
  if (!["workspace", "list", "item", "project", "settings", "clarification", "review", "reviewDecision", "brief"].includes(value)) throw new ValidationError("type must be workspace, list, item, project, settings, clarification, review, reviewDecision or brief.");
  return value;
}
function exactText(value, max, field) {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text.`);
  text(value, max, field);
  return value; // Original capture and editable text retain whitespace exactly.
}
function link(value, field) {
  exactText(value, 2048, field);
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw new ValidationError(`${field} must be an HTTP(S) URL without credentials.`); }
  return value;
}

export function fieldsFor(type, action, input) {
  if (type === 'reviewDecision') return reviewDecisionFields(action, input);
  if (type === 'workspace') {
    object(input, ['title', 'archived'], 'fields');
    const result = {};
    if ('title' in input) {
      result.title = exactText(input.title, 200, 'title');
      if (!result.title.trim()) throw new ValidationError('Workspace title is required.');
    }
    if ('archived' in input) {
      if (typeof input.archived !== 'boolean') throw new ValidationError('archived must be true or false.');
      result.archived = input.archived;
    }
    if (action === 'create' && !result.title || !Object.keys(result).length) throw new ValidationError('Workspace title is required.');
    return action === 'create' ? { archived: false, ...result } : result;
  }
  if (type === 'review' && action === 'create') {
    const { workspaceId, ...fields } = input || {};
    return { ...reviewFields(action, fields), ...(workspaceId === undefined ? {} : { workspaceId: identifier(workspaceId, 'workspaceId') }) };
  }
  if (type === 'brief') return briefFields(action, input);
  if (type === 'review') return reviewFields(action, input);
  if (type === "clarification") return clarificationFields(input);
  if (type === "settings") {
    object(input, ["defaults"], "fields");
    return { defaults: validateDefaults(input.defaults) };
  }
  const shared = ["title", "description", ...(action === "create" || type === "item" ? ["workspaceId"] : [])];
  const capture = ["originalText", "sourceUrl", "sourceTitle", "selectedText", "captureId", "capturedAt", "captureTimeZone"];
  const itemFields = ["listId", "projectId", "plannedDay", "dueDate", "startDate", "reviewDate", "status", "dueDateUtc", "startDateUtc", "reviewDateUtc", "waitingOn", "contexts", "areas", "energy", "timeRequired", "priority", "referenceLinks"];
  const allowed = [...shared, ...(action === "create" ? capture : []), ...(type === "item" ? itemFields : type === "project" ? ["outcome"] : ["defaults"])];
  object(input, allowed, "fields");
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "workspaceId") result[key] = identifier(value, key);
    else if (key === "captureId") result[key] = identifier(value, key);
    else if (key === "capturedAt") {
      if (!value) throw new ValidationError('capturedAt is required.');
      result[key] = utcDate(exactText(value, 24, key));
    }
    else if (key === "captureTimeZone") {
      exactText(value, 100, key);
      try { new Intl.DateTimeFormat('en', { timeZone: value }); }
      catch { throw new ValidationError('captureTimeZone must be a supported timezone.'); }
      result[key] = value;
    }
    else if (key === "defaults") result[key] = validateDefaults(value);
    else if (key === "title") {
      result[key] = exactText(value, 200, key);
      if (!value.trim()) throw new ValidationError("title is required.");
    } else if (key === "outcome") {
      result[key] = exactText(value, 4000, key);
      if (!value.trim()) throw new ValidationError("outcome is required for a project.");
    } else if (["description", "originalText", "sourceTitle", "selectedText", "waitingOn"].includes(key)) {
      result[key] = exactText(value, ({ originalText: 16000, selectedText: 8000, sourceTitle: 2000 })[key] || 4000, key);
    } else if (key === "sourceUrl") result[key] = value === null ? null : link(value, key);
    else if (["listId", "projectId"].includes(key)) result[key] = value === null ? null : identifier(value, key);
    else if (key === "plannedDay") result[key] = calendarDate(value, key);
    else if (key === "status") {
      result[key] = cleanTag(exactText(value, 64, key), key);
      if (!result[key]) throw new ValidationError("status is required.");
    } else if (["dueDate", "startDate", "reviewDate"].includes(key)) result[key] = calendarDate(value, key);
    else if (key.endsWith("DateUtc")) {
      if (value !== null && (typeof value !== "string" || !value)) throw new ValidationError(`${key} must be a UTC date or null.`);
      result[key] = value === null ? null : utcDate(value);
    } else if (["contexts", "areas", "referenceLinks"].includes(key)) {
      if (!Array.isArray(value) || value.length > 20) throw new ValidationError(`${key} must be an array of at most 20 entries.`);
      result[key] = value.map(entry => key === "referenceLinks" ? link(entry, key) : cleanTag(exactText(entry, 64, key), key));
    } else result[key] = value === null ? null : cleanTag(exactText(value, 64, key), key);
  }
  if (action === "create") {
    if (!result.title) throw new ValidationError("title is required.");
    if (type === "project" && !result.outcome) throw new ValidationError("outcome is required for a project.");
    return {
      description: "", originalText: input.originalText ?? input.title,
      sourceUrl: null, sourceTitle: "", selectedText: "",
      ...(type === "item" ? { listId: null, projectId: null, plannedDay: null, status: "inbox", dueDateUtc: null, startDateUtc: null,
        reviewDateUtc: null, waitingOn: "", contexts: [], areas: [], energy: null, timeRequired: null,
        priority: null, referenceLinks: [] } : {}), ...result
    };
  }
  if (!Object.keys(result).length) throw new ValidationError("fields must contain an edit.");
  return result;
}

export function validateOperation(input) {
  object(input, ["apiVersion", "accountId", "operationId", "mutations"], "operation");
  if (input.apiVersion !== 1) throw new ValidationError("apiVersion must be 1.");
  if (typeof input.accountId !== "string" || !input.accountId) throw new ValidationError("accountId is required.");
  identifier(input.operationId, "operationId");
  if (!Array.isArray(input.mutations) || !input.mutations.length || input.mutations.length > 20) {
    throw new ValidationError("mutations must contain 1–20 records.");
  }
  const seen = new Set();
  const mutations = input.mutations.map(mutation => {
    object(mutation, ["type", "id", "action", "expectedVersion", "fields"], "mutation");
    const type = recordType(mutation.type);
    const id = identifier(mutation.id);
    if (type === "workspace" && id === "personal") throw new ValidationError("Personal is the permanent default workspace.");
    if (seen.has(recordId(type, id))) throw new ValidationError("A record may occur only once per operation.");
    seen.add(recordId(type, id));
    if (!["create", "update", "delete", "restore"].includes(mutation.action)) throw new ValidationError("action must be create, update, delete or restore.");
    const { action, expectedVersion } = mutation;
    if (action === "restore" && !["item", "list", "project", "workspace"].includes(type)) throw new ValidationError("Only items, lists, projects and workspaces can be restored.");
    if (type === "settings" && (id !== "settings" || action === "delete")) {
      throw new ValidationError("Use the settings identity and create/update to save or reset defaults.");
    }
    if (!Number.isSafeInteger(expectedVersion) || (action === "create" ? expectedVersion !== 0 : expectedVersion < 1)) {
      throw new ValidationError("expectedVersion must be 0 for create, or the last observed positive version for update/delete/restore.");
    }
    const fieldless = ["delete", "restore"].includes(action);
    if (fieldless && mutation.fields !== undefined) throw new ValidationError(`${action} cannot include fields.`);
    return { type, id, action, expectedVersion, ...(!fieldless ? { fields: fieldsFor(type, action, mutation.fields) } : {}) };
  });
  return { ...input, mutations };
}

export function validateDefaults(input) {
  object(input, Object.keys(defaultSettings), "defaults");
  return Object.fromEntries(Object.keys(defaultSettings).map(key => {
    if (!Array.isArray(input[key]) || input[key].length > 200) throw new ValidationError(`${key} must have at most 200 options.`);
    return [key, [...new Set(input[key].map(value => cleanTag(exactText(value, 64, key), key)).filter(Boolean))]];
  }));
}
