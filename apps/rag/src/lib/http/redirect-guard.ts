// Shared cross-origin-redirect guard for service-to-service fetches that carry
// a Bearer token (the RAG→main admin-API reconciles). A `redirect: "manual"`
// fetch yields either an "opaqueredirect" response (Node/undici: type set,
// status 0) or a raw 3xx. Following such a redirect cross-origin (apex→www, or
// the Vercel deployment-protection wall on atc-main.vercel.app) strips the
// Authorization header on the next hop, turning an authenticated request into
// an anonymous one that often returns a 200 HTML login page — a silent,
// confusing failure. Callers must fail loud instead of following it. (#1273)
export function isCrossOriginRedirect(res: {
  type: string;
  status: number;
}): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}
