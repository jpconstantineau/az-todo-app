import { createHash } from "node:crypto";
import { ValidationError, text, cleanTag, utcDate } from "../shared/validate.mjs";
import { defaultSettings } from "../shared/defaults.mjs";

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
  if (!["list", "item", "settings"].includes(value)) throw new ValidationError("type must be list, item or settings.");
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
  if (type === "settings") {
    object(input, ["defaults"], "fields");
    return { defaults: validateDefaults(input.defaults) };
  }
  const shared = ["title", "description"];
  const capture = ["originalText", "sourceUrl", "sourceTitle", "selectedText"];
  const itemFields = ["listId", "status", "dueDateUtc", "startDateUtc", "reviewDateUtc", "waitingOn", "contexts", "areas", "energy", "timeRequired", "priority", "referenceLinks"];
  const allowed = [...shared, ...(action === "create" ? capture : []), ...(type === "item" ? itemFields : ["defaults"])];
  object(input, allowed, "fields");
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "defaults") result[key] = validateDefaults(value);
    else if (key === "title") {
      result[key] = exactText(value, 200, key);
      if (!value.trim()) throw new ValidationError("title is required.");
    } else if (["description", "originalText", "sourceTitle", "selectedText", "waitingOn"].includes(key)) {
      result[key] = exactText(value, ({ originalText: 16000, selectedText: 8000, sourceTitle: 2000 })[key] || 4000, key);
    } else if (key === "sourceUrl") result[key] = value === null ? null : link(value, key);
    else if (key === "listId") result[key] = value === null ? null : identifier(value, key);
    else if (key === "status") {
      result[key] = cleanTag(exactText(value, 64, key), key);
      if (!result[key]) throw new ValidationError("status is required.");
    } else if (key.endsWith("DateUtc")) {
      if (value !== null && (typeof value !== "string" || !value)) throw new ValidationError(`${key} must be a UTC date or null.`);
      result[key] = value === null ? null : utcDate(value);
    } else if (["contexts", "areas", "referenceLinks"].includes(key)) {
      if (!Array.isArray(value) || value.length > 20) throw new ValidationError(`${key} must be an array of at most 20 entries.`);
      result[key] = value.map(entry => key === "referenceLinks" ? link(entry, key) : cleanTag(exactText(entry, 64, key), key));
    } else result[key] = value === null ? null : cleanTag(exactText(value, 64, key), key);
  }
  if (action === "create") {
    if (!result.title) throw new ValidationError("title is required.");
    return {
      description: "", originalText: input.originalText ?? input.title,
      sourceUrl: null, sourceTitle: "", selectedText: "",
      ...(type === "item" ? { listId: null, status: "inbox", dueDateUtc: null, startDateUtc: null,
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
    if (seen.has(recordId(type, id))) throw new ValidationError("A record may occur only once per operation.");
    seen.add(recordId(type, id));
    if (!["create", "update", "delete"].includes(mutation.action)) throw new ValidationError("action must be create, update or delete.");
    const { action, expectedVersion } = mutation;
    if (type === "settings" && (id !== "settings" || action === "delete")) {
      throw new ValidationError("Use the settings identity and create/update to save or reset defaults.");
    }
    if (!Number.isSafeInteger(expectedVersion) || (action === "create" ? expectedVersion !== 0 : expectedVersion < 1)) {
      throw new ValidationError("expectedVersion must be 0 for create, or the last observed positive version for update/delete.");
    }
    if (action === "delete" && mutation.fields !== undefined) throw new ValidationError("delete cannot include fields.");
    return { type, id, action, expectedVersion, ...(action !== "delete" ? { fields: fieldsFor(type, action, mutation.fields) } : {}) };
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
