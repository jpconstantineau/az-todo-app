// api/shared/security.mjs
// Basic CSRF check for POST handlers: require htmx header and same-origin
export function checkCsrf(req) {
  const hx = req.headers.get("hx-request");
  if (hx !== "true") return false;

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const envAllowed = (process.env.APP_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Fallback to request host origin if APP_ORIGIN not configured
  const reqOrigin = (() => {
    try {
      return new URL(req.url).origin;
    } catch {
      return null;
    }
  })();

  const allowed = envAllowed.length ? envAllowed : reqOrigin ? [reqOrigin] : [];

  const ok =
    (origin && allowed.some((a) => origin.startsWith(a))) ||
    (referer && allowed.some((a) => referer.startsWith(a)));

  return ok;
}