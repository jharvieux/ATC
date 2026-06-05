// CORS headers for endpoints called by external clients (browser extension,
// iOS Shortcut). Auth is via Bearer token so wildcard origin is safe —
// credentials: 'include' is not needed and not used.
export const EXTERNAL_CLIENT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "86400",
} as const;

export function corsOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: EXTERNAL_CLIENT_CORS_HEADERS });
}

// Wraps any Response with the external-client CORS headers. Use this on error
// responses from respondToAuthError so external clients get a proper CORS
// status code rather than a CORS opaque error.
export function withCorsHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(EXTERNAL_CLIENT_CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
