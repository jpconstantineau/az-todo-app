// Browser-session CSRF policy. These headers are not authentication; the SWA
// ingress must authenticate the caller before supplying a client principal.
function parsedOrigin(value, originOnly = false) {
  if (!value || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (originOnly && value !== url.origin) return null;
    if (!originOnly && (value.includes("#") || (value !== url.origin && value !== url.href))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function checkCsrf(req) {
  // Configure public origins when the proxy's backend URL differs from the web
  // origin. Never derive this list from client-controlled forwarded headers.
  const configured = process.env.APP_ORIGIN;
  const allowed = configured === undefined
    ? [parsedOrigin(req.url)]
    : configured.split(",").map(value => parsedOrigin(value.trim(), true));
  if (!allowed.length || allowed.some(origin => !origin)) return false;

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  // Both absent, opaque Origin: null, malformed, or conflicting headers fail
  // closed. A Referer is sufficient only when Origin is absent.
  if (origin === null && referer === null) return false;
  const source = origin === null ? parsedOrigin(referer) : parsedOrigin(origin, true);
  if (!source || !allowed.includes(source)) return false;
  if (referer !== null && parsedOrigin(referer) !== source) return false;
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

export const apiHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-frame-options": "DENY"
};
