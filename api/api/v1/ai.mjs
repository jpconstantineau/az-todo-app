import { app } from "../shared/http.mjs";
import { getUserId } from "../shared/auth.mjs";

const MAX_BODY_BYTES = 32768;
const MAX_PROMPT_CHARS = 24000;
const MAX_PROVIDER_BYTES = 65536;
const TIMEOUT_MS = 15000;
const kinds = new Set(["capture-extraction", "clarification"]);

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json; charset=utf-8" }
});

function configuration(env = process.env) {
  const values = [env.AI_API_URL, env.AI_API_KEY, env.AI_MODEL];
  if (values.every(value => value === undefined || value === "")) return null;
  if (values.some(value => typeof value !== "string" || !value.trim())) return null;
  const [rawUrl, key, model] = values.map(value => value.trim());
  if ([rawUrl, key, model].some(value => /[\u0000-\u001f\u007f]/.test(value)) || key.length > 4096 || model.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(model)) return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || (loopback && !["http:", "https:"].includes(url.protocol)) ||
      url.username || url.password || url.hash || !url.pathname || url.pathname === "/") return null;
  return { url: url.href, key, model, provider: url.hostname.replace(/^www\./, "") };
}

async function readJson(req) {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return { error: json({ apiVersion: 1, error: "json_required", message: "Send application/json." }, 415) };
  const reader = req.body?.getReader();
  if (!reader) return { error: json({ apiVersion: 1, error: "invalid_request", message: "A suggestion request is required." }, 400) };
  const chunks = []; let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > MAX_BODY_BYTES) { await reader.cancel(); return { error: json({ apiVersion: 1, error: "body_too_large", message: "Suggestion request must be at most 32 KiB." }, 413) }; }
    chunks.push(part.value);
  }
  try { return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) }; }
  catch { return { error: json({ apiVersion: 1, error: "invalid_request", message: "Submit valid UTF-8 JSON." }, 400) }; }
}

function schema(kind) {
  if (kind === "clarification") return {
    type: "object", additionalProperties: false, required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 200 } }
  };
  const fields = Object.fromEntries(["title", "description", "listId", "priority", "context", "dueDate", "dueTime", "evidence", "uncertainty"]
    .map(name => [name, { type: "string", maxLength: name === "title" ? 200 : name === "listId" ? 128 : ["priority", "context"].includes(name) ? 64 : 4000 }]));
  return { type: "object", additionalProperties: false, required: ["items", "notes"], properties: {
    notes: { type: "string", maxLength: 4000 }, items: { type: "array", maxItems: 20, items: {
      type: "object", additionalProperties: false, required: Object.keys(fields), properties: fields
    } }
  } };
}

async function boundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = []; let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > MAX_PROVIDER_BYTES) { await reader.cancel(); throw new Error("oversize"); }
    chunks.push(part.value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function validSuggestion(kind, value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  if (kind === "clarification") return Object.keys(value).length === 1 && typeof value.text === "string" && !!value.text.trim() && value.text.length <= 200;
  if (Object.keys(value).some(key => !["items", "notes"].includes(key)) || !Array.isArray(value.items) || value.items.length > 20 || typeof value.notes !== "string" || value.notes.length > 4000) return false;
  const limits = { title: 200, description: 4000, listId: 128, priority: 64, context: 64, dueDate: 4000, dueTime: 4000, evidence: 4000, uncertainty: 4000 };
  return value.items.every(item => item && !Array.isArray(item) && typeof item === "object" &&
    Object.keys(item).length === Object.keys(limits).length && Object.keys(item).every(key => Object.hasOwn(limits, key)) &&
    Object.entries(limits).every(([key, limit]) => typeof item[key] === "string" && item[key].length <= limit));
}

export async function requestSuggestion(config, kind, prompt, fetchImpl = fetch, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: "POST", signal: controller.signal, redirect: "error",
      headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: kind.replace("-", "_"), strict: true, schema: schema(kind) } } })
    });
    if (!response.ok) return { status: response.status === 429 ? 429 : 502, error: response.status === 429 ? "ai_rate_limited" : "ai_provider_error", message: response.status === 429 ? "Cloud AI is busy. Your text is kept; try again later." : "Cloud AI could not complete this suggestion. Your text is kept." };
    const envelope = JSON.parse(await boundedText(response));
    const content = envelope?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content || new TextEncoder().encode(content).length > MAX_PROVIDER_BYTES) throw new Error("malformed");
    if (!validSuggestion(kind, JSON.parse(content))) throw new Error("malformed");
    return { suggestion: content };
  } catch (error) {
    return { status: error?.name === "AbortError" ? 504 : 502, error: error?.name === "AbortError" ? "ai_timeout" : "ai_invalid_response",
      message: error?.name === "AbortError" ? "Cloud AI timed out. Your text is kept; try again." : "Cloud AI returned an invalid suggestion. Your text is kept." };
  } finally { clearTimeout(timeout); }
}

app.http("v1-ai-status", { route: "v1/ai/status", methods: ["GET"], authLevel: "anonymous", handler: async req => {
  if (process.env.V1_API_ENABLED !== "true") return json({ apiVersion: 1, error: "v1_disabled", message: "The v1 API is not enabled in this environment." }, 503);
  getUserId(req.headers); // Authentication is enforced by the shared registration boundary.
  const config = configuration();
  return json({ apiVersion: 1, configured: !!config, ...(config ? { provider: config.provider, model: config.model } : {}) });
} });

app.http("v1-ai-suggestions", { route: "v1/ai/suggestions", methods: ["POST"], authLevel: "anonymous", handler: async req => {
  if (process.env.V1_API_ENABLED !== "true") return json({ apiVersion: 1, error: "v1_disabled", message: "The v1 API is not enabled in this environment." }, 503);
  const config = configuration();
  if (!config) return json({ apiVersion: 1, error: "ai_unavailable", message: "Cloud AI is not configured. Your text is kept." }, 503);
  const parsed = await readJson(req); if (parsed.error) return parsed.error;
  const value = parsed.value;
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !["kind", "prompt"].includes(key)) ||
      !kinds.has(value.kind) || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > MAX_PROMPT_CHARS ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.prompt)) {
    return json({ apiVersion: 1, error: "invalid_request", message: "Suggestion kind and prompt must be valid and bounded." }, 400);
  }
  const result = await requestSuggestion(config, value.kind, value.prompt);
  if (result.error) return json({ apiVersion: 1, error: result.error, message: result.message }, result.status);
  return json({ apiVersion: 1, suggestion: result.suggestion });
} });

export { configuration, schema, validSuggestion };
