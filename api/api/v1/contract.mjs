import { createHash } from "node:crypto";
import { ValidationError, text, cleanTag, utcDate } from "../shared/validate.mjs";
import { defaultSettings } from "../shared/defaults.mjs";
import { calendarDate } from "./workflow.mjs";
import { reviewFields, reviewDecisionFields, reviewReflectionFields } from "./reviews.mjs";
import { clarificationFields } from "./clarification.mjs";
import { briefFields } from "./briefs.mjs";
import { dailyPlanFields, effortEstimate } from './daily-plans.mjs';

import { collectionKinds, validateRef, validateRefs } from './collection-model.mjs';
import { occurrenceId, recurrenceDate, recurrenceRule } from './recurrence-model.mjs';

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
  if (!["workspace", "list", "item", "project", "settings", "clarification", "review", "reviewDecision", "reviewReflection", "brief", "planPreference", "dailyPlan", "dailyPlanRevision", "recurrenceTemplate"].includes(value)) throw new ValidationError("type must be a supported v1 record type.");
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
  if (['planPreference', 'dailyPlan', 'dailyPlanRevision'].includes(type)) return dailyPlanFields(type, action, input);
  if (type === 'reviewDecision') return reviewDecisionFields(action, input);
  if (type === 'reviewReflection') return reviewReflectionFields(action, input);
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
    if (workspaceId === undefined) throw new ValidationError('workspaceId is required.');
    return { ...reviewFields(action, fields), workspaceId: identifier(workspaceId, 'workspaceId') };
  }
  if (type === 'brief') return briefFields(action, input);
  if (type === 'review') return reviewFields(action, input);
  if (type === "clarification") return clarificationFields(input);
  if (type === "settings") {
    object(input, ["defaults"], "fields");
    return { defaults: validateDefaults(input.defaults) };
  }
  if (type === 'recurrenceTemplate') {
    const managed = ['title', 'description', 'workspaceId', 'collectionRefs', 'listId', 'projectId', 'status', 'contexts', 'areas', 'energy', 'timeRequired', 'priority', 'referenceLinks'];
    const recurrence = ['rule', 'paused', 'tombstoned', 'nextOccurrenceNumber', 'nextIntendedDate', 'openOccurrenceId', 'lastResolvedUtc'];
    object(input, [...managed, ...recurrence], 'fields');
    const result = {};
    const itemInput = Object.fromEntries(Object.entries(input).filter(([name]) => managed.includes(name)));
    if (Object.keys(itemInput).length) Object.assign(result, fieldsFor('item', 'update', itemInput));
    if ('rule' in input) result.rule = recurrenceRule(input.rule);
    for (const name of ['paused', 'tombstoned']) if (name in input) {
      if (typeof input[name] !== 'boolean') throw new ValidationError(`${name} must be true or false.`);
      result[name] = input[name];
    }
    if ('nextOccurrenceNumber' in input) {
      if (!Number.isSafeInteger(input.nextOccurrenceNumber) || input.nextOccurrenceNumber < 1) throw new ValidationError('nextOccurrenceNumber must be positive.');
      result.nextOccurrenceNumber = input.nextOccurrenceNumber;
    }
    if ('nextIntendedDate' in input) result.nextIntendedDate = recurrenceDate(input.nextIntendedDate, 'nextIntendedDate');
    if ('openOccurrenceId' in input) result.openOccurrenceId = input.openOccurrenceId === null ? null : identifier(input.openOccurrenceId, 'openOccurrenceId');
    if ('lastResolvedUtc' in input) result.lastResolvedUtc = input.lastResolvedUtc === null ? null : utcDate(input.lastResolvedUtc);
    if (action === 'create') {
      for (const name of ['title', 'workspaceId', 'collectionRefs', 'status', 'rule', 'nextOccurrenceNumber', 'nextIntendedDate']) {
        if (!(name in result)) throw new ValidationError(`${name} is required.`);
      }
      if (!['inbox', 'next'].includes(result.status)) throw new ValidationError('Generated state must be Inbox or Next.');
      if (result.nextOccurrenceNumber !== 1 || result.nextIntendedDate !== result.rule.anchorDate || result.openOccurrenceId || result.lastResolvedUtc || result.paused || result.tombstoned) {
        throw new ValidationError('A new recurrence template must begin active at occurrence 1 with no open or resolved occurrence.');
      }
      return { description: '', listId: null, projectId: null, contexts: [], areas: [], energy: null, timeRequired: null, priority: null, referenceLinks: [], paused: false, tombstoned: false, openOccurrenceId: null, lastResolvedUtc: null, ...result };
    }
    if (!Object.keys(result).length) throw new ValidationError('fields must contain an edit.');
    if ('status' in result && !['inbox', 'next'].includes(result.status)) throw new ValidationError('Generated state must be Inbox or Next.');
    return result;
  }
  const shared = ["title", "description", "workspaceId"];
  const capture = ["originalText", "sourceUrl", "sourceTitle", "selectedText", "captureId", "capturedAt", "captureTimeZone"];
  const recurrenceOccurrenceFields = ['recurrenceTemplateId', 'recurrenceNumber', 'intendedDate', 'sourceTemplateVersion', 'occurrenceState', 'occurrenceResolvedUtc'];
  const itemFields = ["collectionRefs", "listId", "projectId", "plannedDay", "plannedWeek", "dueDate", "startDate", "reviewDate", "status", "dueDateUtc", "startDateUtc", "reviewDateUtc", "waitingOn", "contexts", "areas", "energy", "timeRequired", "priority", "effortEstimate", "referenceLinks", ...recurrenceOccurrenceFields];
  const allowed = [...shared, ...(action === "create" ? capture : []), ...(type === "item" ? itemFields : type === "project" ? ["outcome", "parentRef", "status", "revisitDate"] : ["defaults", "kind", "parentRef", "revisitDate"])];
  object(input, allowed, "fields");
  if (action === 'create') {
    if (!('workspaceId' in input)) throw new ValidationError('workspaceId is required.');
    if (type === 'item' && !('collectionRefs' in input)) throw new ValidationError('collectionRefs is required.');
    if (type === 'project' && !('status' in input)) throw new ValidationError('status is required for a project.');
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'collectionRefs' || key === 'parentRef') {
      try { result[key] = key === 'collectionRefs' ? validateRefs(value) : value === null ? null : validateRef(value); }
      catch (error) { throw new ValidationError(error.message); }
    }
    else if (key === 'kind') {
      if (typeof value !== 'string' || !Object.hasOwn(collectionKinds, value) || value === 'project') throw new ValidationError('Choose a supported list kind. Projects retain their own identity.');
      result[key] = value;
    }
    else if (key === "workspaceId") result[key] = identifier(value, key);
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
    else if (key === 'recurrenceTemplateId') result[key] = identifier(value, key);
    else if (key === 'recurrenceNumber' || key === 'sourceTemplateVersion') {
      if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError(`${key} must be positive.`);
      result[key] = value;
    }
    else if (key === 'intendedDate') result[key] = recurrenceDate(value, key);
    else if (key === 'occurrenceState') {
      if (!['open', 'completed', 'skipped'].includes(value)) throw new ValidationError('occurrenceState must be open, completed or skipped.');
      result[key] = value;
    }
    else if (key === 'occurrenceResolvedUtc') result[key] = value === null ? null : utcDate(value);
    else if (key === "defaults") result[key] = validateDefaults(value);
    else if (key === "title") {
      result[key] = exactText(value, 200, key);
      if (!value.trim()) throw new ValidationError("title is required.");
    } else if (key === "outcome") {
      result[key] = exactText(value, 4000, key);
    } else if (["description", "originalText", "sourceTitle", "selectedText", "waitingOn"].includes(key)) {
      result[key] = exactText(value, ({ originalText: 16000, selectedText: 8000, sourceTitle: 2000 })[key] || 4000, key);
    } else if (key === "sourceUrl") result[key] = value === null ? null : link(value, key);
    else if (["listId", "projectId"].includes(key)) result[key] = value === null ? null : identifier(value, key);
    else if (["plannedDay", "plannedWeek"].includes(key)) result[key] = calendarDate(value, key);
    else if (key === 'effortEstimate') result[key] = effortEstimate(value);
    else if (key === "status") {
      if (type === 'project' && !['draft', 'active', 'someday', 'completed'].includes(value)) throw new ValidationError('Choose a draft, active, someday or completed project status.');
      result[key] = cleanTag(exactText(value, 64, key), key);
      if (!result[key]) throw new ValidationError("status is required.");
    } else if (["dueDate", "startDate", "reviewDate", "revisitDate"].includes(key)) result[key] = calendarDate(value, key);
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
    if (type === "project" && result.status !== 'draft' && !result.outcome?.trim()) throw new ValidationError("outcome is required for an active, someday or completed project.");
    if (type === 'item' && result.recurrenceTemplateId) {
      for (const name of recurrenceOccurrenceFields) if (!(name in result)) throw new ValidationError(`${name} is required for a recurring occurrence.`);
    }
    return {
      description: "", originalText: input.originalText ?? input.title,
      sourceUrl: null, sourceTitle: "", selectedText: "",
      ...(type === 'project' ? { outcome: '' } : {}),
      ...(type === "item" ? { collectionRefs: [], listId: null, projectId: null, plannedDay: null, plannedWeek: null, status: "inbox", dueDateUtc: null, startDateUtc: null,
        reviewDateUtc: null, waitingOn: "", contexts: [], areas: [], energy: null, timeRequired: null,
        priority: null, effortEstimate: null, referenceLinks: [] } : {}), ...result
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
    if (type === 'recurrenceTemplate' && fieldless) throw new ValidationError('Recurring templates are paused or stopped, not deleted or restored.');
    if (fieldless && mutation.fields !== undefined) throw new ValidationError(`${action} cannot include fields.`);
    const fields = fieldless ? undefined : fieldsFor(type, action, mutation.fields);
    if (type === 'item' && action === 'create' && fields.recurrenceTemplateId && id !== occurrenceId(fields.recurrenceTemplateId, fields.recurrenceNumber)) {
      throw new ValidationError('Recurring occurrence identity is invalid.');
    }
    return { type, id, action, expectedVersion, ...(!fieldless ? { fields } : {}) };
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
