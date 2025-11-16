// api/shared/security.mjs
// Basic CSRF check for POST handlers: require htmx header and same-origin.
// Allows same-origin POSTs even if Origin/Referer headers are missing (some
// browsers omit them), but still blocks obvious cross-origin.
export function checkCsrf(req) {
  const hx = req.headers.get("hx-request");
  if (hx !== "true") return false;

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const envAllowed = (process.env.APP_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Compute the request's own origin as a fallback allowed origin
  let reqOrigin = null;
  try {
    reqOrigin = new URL(req.url).origin;
  } catch {
    // ignore
  }
  const allowed = envAllowed.length ? envAllowed : reqOrigin ? [reqOrigin] : [];

  // If we have an Origin or Referer, one of them must match allowed origins
  if (origin || referer) {
    const ok =
      (origin && allowed.some((a) => origin.startsWith(a))) ||
      (referer && allowed.some((a) => referer.startsWith(a)));
    return ok;
  }

  // If both are missing, treat as same-origin (since SWA proxies on same origin)
  return true;
}