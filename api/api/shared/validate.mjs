// api/shared/validate.mjs
export function clip(s, max) {
  if (s == null) return "";
  s = String(s).trim();
  return s.length > max ? s.slice(0, max) : s;
}

export function cleanTag(s) {
  if (s == null) return "";
  // remove control chars, trim, cap to 64
  s = String(s).replace(/[\u0000-\u001f]/g, "").trim();
  return clip(s, 64);
}

export function toArrayClean(form, key, maxItems = 200) {
  const vals = form.getAll(key) || [];
  const cleaned = vals
    .map((v) => cleanTag(v))
    .filter((v) => v.length > 0)
    .filter((v, i, a) => a.indexOf(v) === i);
  return cleaned.slice(0, maxItems);
}

export function requireNonEmpty(s, fieldName) {
  if (!s || !String(s).trim()) {
    throw new Response(`${fieldName} required`, { status: 400 });
  }
}