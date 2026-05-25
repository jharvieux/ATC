// Spec ref: §1.4 (tenant resolution), §3.6 (resolution logic), §26.x (admin gate), BP04
//
// Runtime: Next.js edge runtime locally; Vercel deploys this under Fluid
// Compute (Node.js). @supabase/supabase-js v2 is edge-compatible so no
// explicit `runtime = 'nodejs'` is needed. See MEMORY.md D-037 for rationale.

import { NextRequest, NextResponse } from "next/server";
import {
  getTenantBySlug,
  getTenantByCustomDomain,
  type Tenant,
} from "@/lib/tenancy/resolve-tenant";
import { derivePaymentState } from "@/lib/billing/payment-state";
import { extractAttributionFromRequest } from "@/lib/attribution/extract-utm";

const RESOLVED_TENANT_ID_HEADER = "x-resolved-tenant-id";
const RESOLVED_TENANT_TYPE_HEADER = "x-resolved-tenant-type";
// §15.16 — Payment gate banner state, surfaced to the app layout so it can
// render the "payment required" banner. One of "" (clear), "within_grace",
// or "past_grace".
const PAYMENT_BANNER_HEADER = "x-payment-banner-state";

// §35.2.2 — pending UTM attribution cookie. Holds the most recent
// UTM-bearing request's payload until a contact identifies; identification
// handlers then write a touch row and clear the cookie. Last-write-wins
// for UTM-bearing requests within a session.
const ATTRIBUTION_PENDING_COOKIE = "atc_attribution_pending";
const ATTRIBUTION_COOKIE_MAX_AGE_DAYS = 30;
// §35.10 — consent must be respected. Honors the existing tenant consent
// cookie that signup writes on consent capture; if the cookie says
// "rejected" we skip pending attribution writes entirely.
const COOKIE_CONSENT_COOKIE = "atc_cookie_consent";

// Build a request-headers clone with any caller-supplied resolution headers
// stripped. Route handlers and Server Components must only ever read the
// values set by THIS middleware — never anything inbound from the network.
//
// Why this exists: NextResponse.next() alone does NOT forward modified
// request headers to handlers; you have to pass them explicitly via the
// `request: { headers }` option. Without that, route handlers can read
// attacker-supplied `x-resolved-tenant-id` headers verbatim. See the
// 2026-05-25 security audit finding "middleware tenant resolution doesn't
// propagate".
function cloneAndScrubHeaders(req: NextRequest): Headers {
  const headers = new Headers(req.headers);
  headers.delete(RESOLVED_TENANT_ID_HEADER);
  headers.delete(RESOLVED_TENANT_TYPE_HEADER);
  headers.delete(PAYMENT_BANNER_HEADER);
  return headers;
}

function applyAttributionCapture(res: NextResponse, req: NextRequest): void {
  // §35.10 — refused-consent suppression. If the consent cookie is "rejected",
  // do not capture pending attribution. Treat as direct-visit downstream.
  const consent = req.cookies.get(COOKIE_CONSENT_COOKIE)?.value;
  if (consent === "rejected") return;

  const referrer = req.headers.get("referer");
  const extracted = extractAttributionFromRequest({
    url: req.nextUrl,
    referrer,
  });
  if (!extracted) return; // non-UTM request leaves any existing pending cookie alone

  res.cookies.set({
    name: ATTRIBUTION_PENDING_COOKIE,
    value: encodeURIComponent(JSON.stringify(extracted)),
    httpOnly: false, // intentionally readable by client-side identification flows
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ATTRIBUTION_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60,
    path: "/",
  });
}

// Paths exempt from the past-grace redirect. The billing UI obviously can't
// be gated by itself; webhook + auth + health must remain reachable.
const PAYMENT_GATE_EXEMPT_PREFIXES: readonly string[] = [
  "/settings/billing",
  "/api/tenant/billing",
  "/api/webhooks/stripe",
  "/api/webhooks/", // includes /resend for unsubscribe etc.
  "/api/auth/",
  "/api/health",
  "/legal/", // disclaimers must be readable
];

function isExemptFromPaymentGate(pathname: string): boolean {
  return PAYMENT_GATE_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

function applyPaymentGate(
  res: NextResponse,
  req: NextRequest,
  tenant: Tenant,
): NextResponse {
  const state = derivePaymentState(tenant);
  if (state.isPaying) {
    res.headers.set(PAYMENT_BANNER_HEADER, "");
    return res;
  }
  // Non-paying. If past grace AND not on an exempt path, redirect to billing.
  if (state.isPastGrace && !isExemptFromPaymentGate(req.nextUrl.pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/settings/billing";
    url.search = "?gate=past_grace";
    return NextResponse.redirect(url);
  }
  // Within grace, or past grace on an exempt page → let through with banner.
  res.headers.set(
    PAYMENT_BANNER_HEADER,
    state.isPastGrace ? "past_grace" : "within_grace",
  );
  return res;
}

// §26 — Platform-admin API gate.
//
// Front-door check on /api/admin/*. The request must present one of:
//   (a) Authorization: Bearer ${MAIN_APP_ADMIN_API_KEY} — service-to-service.
//   (b) Authorization: Bearer <three-segment JWT> — a Supabase user session,
//       whose full verification (signature + platform_admins lookup) happens
//       in the route handler via assertPlatformAdmin().
//
// Middleware deliberately shape-checks but doesn't verify the JWT — full
// verification would mean a DB lookup on every admin request. The handler
// does the authoritative check. Prior unauthenticated x-admin-user-id
// pattern (2026-05-25 audit Finding 1, confidence 10) is closed by the
// combination of this gate + assertPlatformAdmin.
function isAdminApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/admin/") || pathname === "/api/admin";
}

function bearerToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const t = auth.slice("Bearer ".length).trim();
  return t.length > 0 ? t : null;
}

function looksLikeJwt(token: string): boolean {
  // Shape check only — three base64-url segments. Handler verifies signature.
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

function isAcceptableAdminBearer(req: NextRequest): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  const serviceKey = process.env.MAIN_APP_ADMIN_API_KEY;
  if (serviceKey && token === serviceKey) return true;
  return looksLikeJwt(token);
}

function adminForbidden(): NextResponse {
  return NextResponse.json(
    {
      error: "admin_gate_blocked",
      detail:
        "This endpoint requires a verified platform admin credential — " +
        "either the service-to-service Bearer token or a Supabase session " +
        "JWT belonging to a row in platform_admins. See §26.",
    },
    { status: 403 },
  );
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;

  // 0. Admin API gate — runs BEFORE everything else so no later code path
  //    can leak a tenant header or attribution side-effect into an admin call.
  if (isAdminApiPath(pathname) && !isAcceptableAdminBearer(req)) {
    return adminForbidden();
  }

  // 1. Tier-2 E2E auth bypass — short-circuits tenant resolution when a
  //    request carries the bypass Bearer. Gated behind NODE_ENV !== production
  //    AND VERCEL_ENV !== "production" AND the bypass env vars being set.
  //    Belt-and-suspenders against an env var misconfiguration on a prod
  //    deploy: the 2026-05-25 audit (Finding 3) flagged that a leaked
  //    TEST_AUTH_BYPASS_TOKEN on a non-prod NODE_ENV host would yield full
  //    tenant impersonation. The VERCEL_ENV check is independent of
  //    NODE_ENV and survives mistakes like `vercel build` shipping with a
  //    test-flavored NODE_ENV.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production"
  ) {
    const expected = process.env.TEST_AUTH_BYPASS_TOKEN;
    const bypassTenant = process.env.TEST_AUTH_BYPASS_TENANT_ID;
    if (expected && bypassTenant) {
      const auth = req.headers.get("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
      if (token === expected) {
        const headers = cloneAndScrubHeaders(req);
        headers.set(RESOLVED_TENANT_ID_HEADER, bypassTenant);
        headers.set(RESOLVED_TENANT_TYPE_HEADER, "byo_host");
        return NextResponse.next({ request: { headers } });
      }
    }
  }

  const host = req.headers.get("host") ?? "";
  // Strip port for local dev comparisons.
  const hostname = host.replace(/:\d+$/, "");

  const primaryDomain = process.env.PLATFORM_PRIMARY_DOMAIN ?? "";
  const domainRegex = process.env.PLATFORM_DOMAIN_REGEX ?? "";

  // 2. Platform admin domain — passes through with "platform" sentinel.
  if (hostname === primaryDomain) {
    const headers = cloneAndScrubHeaders(req);
    headers.set(RESOLVED_TENANT_ID_HEADER, "platform");
    headers.set(RESOLVED_TENANT_TYPE_HEADER, "platform");
    return NextResponse.next({ request: { headers } });
  }

  // 3. Subdomain of the platform primary domain — resolve by slug.
  if (domainRegex) {
    const match = hostname.match(new RegExp(domainRegex));
    const slug = match?.[1];
    if (match && slug) {
      try {
        const tenant = await getTenantBySlug(slug);
        if (tenant) {
          const headers = cloneAndScrubHeaders(req);
          headers.set(RESOLVED_TENANT_ID_HEADER, tenant.id);
          headers.set(RESOLVED_TENANT_TYPE_HEADER, tenant.tenant_type);
          const res = NextResponse.next({ request: { headers } });
          applyAttributionCapture(res, req);
          return applyPaymentGate(res, req, tenant);
        }
      } catch {
        // DB error — fall through to 404. Don't leak DB error details.
      }
      return notFound();
    }
  }

  // 4. Custom domain — resolve by full hostname.
  try {
    const tenant = await getTenantByCustomDomain(hostname);
    if (tenant) {
      const headers = cloneAndScrubHeaders(req);
      headers.set(RESOLVED_TENANT_ID_HEADER, tenant.id);
      headers.set(RESOLVED_TENANT_TYPE_HEADER, tenant.tenant_type);
      const res = NextResponse.next({ request: { headers } });
      return applyPaymentGate(res, req, tenant);
    }
  } catch {
    // DB error — fall through to 404.
  }

  return notFound();
}

function notFound(): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><title>Site not found</title></head><body>` +
      `<h1>This site is not currently active.</h1>` +
      `<p>If you believe this is an error, please contact support.</p>` +
      `</body></html>`,
    {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

export const config = {
  // Run on all paths except Next.js internals and static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
