// CORS headers for endpoints called by external clients (browser extension,
// iOS Shortcut). Auth is via Bearer token so wildcard origin is safe —
// credentials: 'include' is not needed and not used.
export const EXTENSION_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "86400",
};

export function corsOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: EXTENSION_CORS_HEADERS });
}
