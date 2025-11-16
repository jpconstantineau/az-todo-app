// api/shared/auth.mjs
export function getClientPrincipal(headers) {
  const b64 = headers.get("x-ms-client-principal");
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function getUserId(headers) {
  const cp = getClientPrincipal(headers);
  return cp?.userId || null; // stable GUID from SWA
}