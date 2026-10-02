// api/shared/auth.mjs
export function getClientPrincipal(headers) {
  const b64 = headers.get("x-ms-client-principal");
  if (!b64 || b64.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    const principal = JSON.parse(json);
    if (!principal || typeof principal.userId !== "string" ||
        !principal.userId.trim() || principal.userId.length > 200 ||
        /[\u0000-\u0020\u007f]/.test(principal.userId) ||
        !Array.isArray(principal.userRoles) ||
        !principal.userRoles.every(role => typeof role === "string") ||
        !principal.userRoles.includes("authenticated")) return null;
    // Shape validation only: the trusted SWA ingress supplies this header.
    // Never expose these handlers as a public, unauthenticated Functions app.
    return principal;
  } catch {
    return null;
  }
}

export function getUserId(headers) {
  const cp = getClientPrincipal(headers);
  return cp?.userId || null; // stable GUID from SWA
}
