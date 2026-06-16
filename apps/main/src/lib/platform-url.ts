// Origin (scheme + host) for absolute redirect URLs the browser is sent to —
// Stripe Checkout success/cancel URLs and Connect account-link refresh/return
// URLs in the onboarding flow.
//
// These MUST resolve to the tenant's own host (subdomain or custom domain),
// NOT a platform-level origin. Onboarding APIs derive tenant_id from the
// request Host (proxy.ts → x-resolved-tenant-id); on the platform domain that
// header is the "platform" sentinel, so a redirect there makes every
// onboarding call throw and the page renders "Failed to load page". Deriving
// the origin from the incoming request keeps the user on the host that
// resolves to their real tenant. Mirrors the `new URL(req.url)` convention used
// by getAuthCookieDomain in ssr-client.ts (req.url is always a valid absolute
// URL on NextRequest).
export function tenantOriginFromRequest(req: Request): string {
  return new URL(req.url).origin;
}
