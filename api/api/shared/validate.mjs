export class ValidationError extends Error {}

export async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    throw new ValidationError("Submit a valid form body.");
  }
}

export function text(value, max, field = "Text") {
  if (value == null) return "";
  if (typeof value !== "string") throw new ValidationError(`${field} must be text.`);
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${field} contains unsupported control characters.`);
  }
  return value.trim();
}

export function cleanTag(value, field = "Option") {
  const result = text(value, 64, field);
  if (/[\r\n\t]/.test(result)) throw new ValidationError(`${field} must be a single line.`);
  return result;
}

export function utcDate(value) {
  const result = text(value, 24, "Due date");
  if (!result) return "";
  const canonical = result.includes(".") ? result : result.replace("Z", ".000Z");
  // Date.parse alone normalizes impossible dates such as February 30.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(result) ||
      Number.isNaN(Date.parse(result)) ||
      new Date(result).toISOString() !== canonical) {
    throw new ValidationError("Choose a valid due date and time in UTC.");
  }
  return result;
}

export function toArrayClean(form, key, maxItems = 200) {
  const label = key.replace("[]", "");
  const values = form.getAll(key).flatMap(value => {
    if (typeof value !== "string") throw new ValidationError(`${label} must be text.`);
    return value.split(/\r?\n/);
  }).map(value => cleanTag(value, label)).filter(Boolean);
  if (values.length > maxItems) throw new ValidationError(`${label} must have at most ${maxItems} options.`);
  return [...new Set(values)];
}

export function requireNonEmpty(value, field) {
  if (!value) throw new ValidationError(`${field} required`);
}
