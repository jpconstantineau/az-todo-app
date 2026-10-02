import { app } from "../shared/http.mjs";
import { getUserId } from "../shared/auth.mjs";
import { ValidationError } from "../shared/validate.mjs";
import { identifier, recordType, recordId, digest, validateOperation, MAX_BODY_BYTES } from "./contract.mjs";
import { ApiError, commit, read, changes, legacyDefaults } from "./store.mjs";
import { defaultSettings } from "../shared/defaults.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
function route(name, method, handler) {
  app.http(`v1-${name}`, { route: `v1/${name}`, methods: [method], authLevel: "anonymous",
    handler: async req => {
      try {
        if (process.env.V1_API_ENABLED !== "true") throw new ApiError(503, "v1_disabled", "The v1 API is not enabled in this environment.");
        const accountId = getUserId(req.headers);
        return await handler(req, accountId);
      } catch (error) {
        if (error instanceof ValidationError) return json({ apiVersion: 1, error: "invalid_request", message: error.message }, 400);
        if (error instanceof ApiError) return json({ apiVersion: 1, error: error.code, message: error.message }, error.status);
        // Avoid logging raw task text or Cosmos request bodies.
        return json({ apiVersion: 1, error: "storage_unavailable", message: "The request could not be acknowledged. Retain pending work and retry unchanged." }, 503);
      }
    }
  });
}
function requireAccount(value, accountId) {
  if (value !== accountId) throw new ApiError(409, "account_mismatch", "Pause this account's queue. Sign back into its original account to resume.");
}
function number(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new ValidationError("after/limit must be bounded non-negative integers.");
  }
  return Number(value);
}
route("session", "GET", async (req, accountId) => json({ apiVersion: 1, accountId, defaultSettings, legacyDefaults: await legacyDefaults(accountId) }));
route("operations", "POST", async (req, accountId) => {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "json_required", "Send application/json.");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new ValidationError("A JSON operation is required.");
  const chunks = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new ApiError(413, "body_too_large", "Operation must be at most 64 KiB."); }
    chunks.push(part.value);
  }
  let raw;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ValidationError("Submit valid UTF-8 JSON."); }
  const operation = validateOperation(raw);
  requireAccount(operation.accountId, accountId);
  const receipt = await commit(accountId, operation, digest(raw));
  return json(receipt, receipt.status === "conflict" ? 409 : 200);
});
route("records", "GET", async (req, accountId) => {
  requireAccount(req.query.get("accountId"), accountId);
  const doc = await read(accountId, recordId(recordType(req.query.get("type")), identifier(req.query.get("id"))));
  if (!doc) throw new ApiError(404, "record_not_found", "Record not found.");
  return json({ apiVersion: 1, accountId, record: doc.record });
});
route("receipts", "GET", async (req, accountId) => {
  requireAccount(req.query.get("accountId"), accountId);
  const doc = await read(accountId, `receipt:${identifier(req.query.get("operationId"), "operationId")}`);
  if (!doc) throw new ApiError(404, "receipt_not_found", "No acknowledgement is visible yet; retry the original operation unchanged.");
  return json(doc.response);
});
route("changes", "GET", async (req, accountId) => {
  requireAccount(req.query.get("accountId"), accountId);
  const after = number(req.query.get("after"), 0, Number.MAX_SAFE_INTEGER);
  const limit = number(req.query.get("limit"), 10, 50);
  if (!limit) throw new ValidationError("limit must be between 1 and 50.");
  return json(await changes(accountId, after, limit));
});
