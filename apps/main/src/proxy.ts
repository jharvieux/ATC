// Spec ref: §1.4 (tenant resolution), §3.6 (resolution logic), §26.x (admin gate), BP04
//
// Runtime: Next.js edge runtime locally; Vercel deploys this under Fluid
// Compute (Node.js). @supabase/supabase-js v2 is edge-compatible so no
// explicit `runtime = 'nodejs'` is needed. See MEMORY.md D-037 for rationale.

import { NextRequest, NextResponse } from "next/server";
import {
  getTenantBySlug,
  getTenantByCustomDomain,
  getTenantByAuthUserId,
  getTenantById,
  type Tenant,
} from "@/lib/tenancy/resolve-tenant";
import { derivePaymentState } from "@/lib/billing/payment-state";
import { extractAttributionFromRequest } from "@/lib/attribution/extract-utm";
import {
  createMiddlewareClient,
  clearAuthCookies,
  isInvalidSessionError,
  AUTH_TOKEN_COOKIE_RE,
} from "@/lib/auth/ssr-client";
import { verifyIdentity } from "@/lib/auth/verify-identity";
import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { matchesAdminApiKey } from "@/lib/auth/admin-api-key";
import { resolveIndexingTarget } from "@/lib/seo/resolve-indexing-target";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import {
  matchesAnyPrefix,
  pathMatchesPrefix,
  ADMIN_API_PREFIXES,
  AUTH_API_PREFIXES,
  AUTH_FLOW_PAGE_PREFIXES,
  CHAT_PAGE_PREFIXES,
  CHAT_API_PREFIXES,
  CONSOLE_PAGE_PREFIXES,
  CONSOLE_API_PREFIXES,
  LOGIN_GATED_PREFIXES,
} from "@/lib/tenancy/route-classification";

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
//   (a) Authorization: Bearer ${MAIN_APP_ADMIN_API_KEY} — service-to-service,
//       accepted only on the service-bearer paths (#2002 — see
//       isServiceBearerAdminPath), not all of /api/admin/*.
//   (b) A Supabase auth cookie (sb-<ref>-auth-token[.N]) — a human admin's
//       session, fully verified downstream by assertPlatformAdmin() (signature
//       + platform_admins lookup). Pre-§17.x this was a Bearer JWT in
//       Authorization; the cookie migration moved the session storage but
//       not the authority model.
//
// Middleware deliberately shape-checks but doesn't verify — full verification
// would mean a DB lookup on every admin request. The prior unauthenticated
// x-admin-user-id pattern (2026-05-25 audit Finding 1, confidence 10) is
// closed by the combination of this gate + assertPlatformAdmin.
function isAdminApiPath(pathname: string): boolean {
  return matchesAnyPrefix(pathname, ADMIN_API_PREFIXES);
}

// §26 — Platform-admin PAGE routes: the (admin) route group, which serves
// /admin/* and /supervisor/*. Distinct from isAdminApiPath (/api/admin/*).
// These pages are gated authoritatively in (admin)/layout.tsx via
// assertPlatformAdmin; the middleware adds the coarse shape-check + host
// restriction below as the second layer.
function isAdminPagePath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/supervisor" ||
    pathname.startsWith("/supervisor/")
  );
}

// §#1050 — pages that require an active session regardless of domain.
// /signup/complete lives on the platform domain; /onboarding/* lives on
// tenant subdomains. Both are "use client" pages with no server-side gate —
// unauthenticated deep-links silently fail at submit without this check.
function isLoginGatedPath(pathname: string): boolean {
  return matchesAnyPrefix(pathname, LOGIN_GATED_PREFIXES);
}

// §17.x self-heal (#1361) — the sign-in / sign-up surface. A request here with
// a bad session cookie gets the cookie cleared but is NOT redirected: these
// pages (and /api/auth/*, which establishes the new session) ARE where the user
// establishes a session, so bouncing them to /auth/reauth would loop or
// interrupt the funnel. Everything else redirects.
function isAuthFlowPath(pathname: string): boolean {
  // /signup/complete is POST-auth (login-gated, #1050): it needs a live session,
  // so a dead cookie there must re-auth, not clear-in-place. Exclude it.
  if (pathname === "/signup/complete") return false;
  return matchesAnyPrefix(pathname, [
    ...AUTH_FLOW_PAGE_PREFIXES,
    ...AUTH_API_PREFIXES,
  ]);
}

function hasSupabaseAuthCookie(req: NextRequest): boolean {
  for (const c of req.cookies.getAll()) {
    if (AUTH_TOKEN_COOKIE_RE.test(c.name)) return true;
  }
  return false;
}

// #2002 — the service bearer's authority is capped to the rag admin area at
// the handler layer (ADMIN_AREA_GRANTS caps role "service" to area "rag").
// This front-door check mirrors that grant: the bearer admits the two
// bearer-only reconcile endpoints (exact paths — their /api/admin/tenants/*
// siblings are superadmin-area) plus the /api/admin/rag prefix, narrowing the
// front door to match the handler layer instead of all of /api/admin/*.
const SERVICE_BEARER_EXACT_PATHS: readonly string[] = [
  "/api/admin/tenants",
  "/api/admin/platform-settings",
];

function isServiceBearerAdminPath(pathname: string): boolean {
  // Strip one trailing slash so /api/admin/tenants/ doesn't 403 opaquely.
  const normalized = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return (
    SERVICE_BEARER_EXACT_PATHS.includes(normalized) ||
    pathMatchesPrefix(pathname, "/api/admin/rag")
  );
}

function isAcceptableAdminCredential(req: NextRequest, pathname: string): boolean {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && isServiceBearerAdminPath(pathname)) {
    const token = auth.slice("Bearer ".length).trim();
    if (matchesAdminApiKey(token)) return true;
  }
  return hasSupabaseAuthCookie(req);
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

/**
 * Indexing gate (D-368 + #2058). Platform subdomains remain noindex; verified
 * Agency custom domains may opt in. robots.txt alone can't enforce this: a
 * disallowed URL that someone links to still gets indexed URL-only, and a
 * crawler that never fetches robots.txt never sees the rule. X-Robots-Tag
 * travels with the response.
 *
 * Applied at the wrapper rather than at each of proxy()'s ~12 return points
 * so a future early-return can't silently become indexable.
 */
export async function proxy(req: NextRequest): Promise<NextResponse> {
  const res = await resolveRequest(req);
  if (!(await resolveIndexingTarget(req.headers.get("host")))) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return res;
}

async function resolveRequest(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;

  // 0. Admin API gate — runs BEFORE everything else so no later code path
  //    can leak a tenant header or attribution side-effect into an admin call.
  if (isAdminApiPath(pathname) && !isAcceptableAdminCredential(req, pathname)) {
    return adminForbidden();
  }

  // 0b. Vercel cron invocations (#2045) — Vercel calls cron paths on the
  //     deployment's *.vercel.app host, which resolves to no tenant, so host
  //     resolution 404'd every production cron (step 5's preview fallback is
  //     deliberately non-production-only). Cron routes are tenantless and each
  //     authenticates itself fail-closed via assertCronAuth (Bearer
  //     CRON_SECRET, unset secret rejects), so bypass session verification and
  //     tenant resolution entirely and forward the platform sentinel.
  if (pathname.startsWith("/api/cron/")) {
    const headers = cloneAndScrubHeaders(req);
    headers.set(RESOLVED_TENANT_ID_HEADER, "platform");
    headers.set(RESOLVED_TENANT_TYPE_HEADER, "platform");
    return NextResponse.next({ request: { headers } });
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
      // Constant-time compare — same posture as lib/auth/test-bypass.ts
      // (audit pass 2, Finding 2 — non-constant-time bearer compare leaked
      // the secret via timing).
      const tokenOk =
        token != null &&
        Buffer.byteLength(token) === Buffer.byteLength(expected) &&
        Buffer.compare(Buffer.from(token), Buffer.from(expected)) === 0;
      if (tokenOk) {
        const headers = cloneAndScrubHeaders(req);
        headers.set(RESOLVED_TENANT_ID_HEADER, bypassTenant);
        headers.set(RESOLVED_TENANT_TYPE_HEADER, "byo_host");
        return NextResponse.next({ request: { headers } });
      }
    }
  }

  // 1b. Session verify + refresh (§17.x, #1932). With cookie-based PKCE
  //     sessions the SERVER refreshes — the browser no longer holds tokens.
  //     applyRefreshedSession flushes any rotated cookies (and Supabase's
  //     no-cache headers) onto whichever response a resolution branch returns.
  //     Supabase rotates the refresh token on every use, so skipping the
  //     refresh kills sessions at the 1h mark. Runs after the admin gate +
  //     test bypass (neither uses cookie sessions) and before tenant
  //     resolution so cloneAndScrubHeaders forwards the freshened Cookie
  //     header downstream.
  //
  //     Hybrid verification (#1932) — this used to be an unconditional
  //     getUser() network round-trip on every request. Now the hot path is
  //     verifyIdentity() → getClaims(): a LOCAL ES256 signature check against
  //     auth-js's cached JWKS. Refresh timing is unchanged because no-arg
  //     getClaims() reads the session via getSession(), which itself calls
  //     _callRefreshToken when the access token is within EXPIRY_MARGIN_MS
  //     (90s) of expiry — the exact same margin getUser() refreshed under —
  //     and that rotation fires the middleware client's setAll capture just
  //     like getUser()'s did. Steady-state requests pay zero GoTrue calls.
  //
  //     Fail-safe handoff: ANY local-verify miss — no session, bad signature,
  //     refresh rejected, JWKS cold-cache fetch failure, or an exotic decode
  //     throw (getClaims rethrows non-AuthErrors, e.g. bad JSON inside valid
  //     base64url) — falls through to the network getUser(), and ONLY its
  //     error feeds the #1361 self-heal below. Local error objects
  //     (AuthInvalidJwtError) never reach the heal classifier: classifying
  //     local failures directly would clear cookies on a JWKS blip.
  //
  //     THE _removeSession SEAM (audit finding, PR #1987): when the refresh
  //     INSIDE getClaims fails on a dead/rotated refresh token, auth-js's
  //     _callRefreshToken calls _removeSession() before returning — so by the
  //     time the handoff getUser() runs, the session storage is already empty
  //     and it reports AuthSessionMissingError, NOT the AuthApiError the
  //     pre-#1932 single getUser() surfaced. The heal below therefore also
  //     treats session-missing-with-cookie-present as definitively dead (see
  //     §1b-heal). Without that, the heal's primary scenario (dead refresh
  //     token) would silently degrade to clear-without-redirect.
  //
  //     Accepted tradeoffs (documented, not accidental): (a) a server-side
  //     revoked session now passes the middleware until its access token
  //     expires (≤1h) — authoritative gates (assertPermission, RLS,
  //     assertPlatformAdmin) still verify per-request, so this widens only the
  //     redirect/tenant-resolution surface; (b) during an auth-server
  //     brownout a request may issue two refresh POSTs (one in getClaims, one
  //     in the handoff getUser).
  //
  //     Kill switch: AUTH_MIDDLEWARE_LOCAL_VERIFY_DISABLED=true (the repo's
  //     standard X_DISABLED==="true" flag idiom, cf. BOOKING_CRONS_DISABLED)
  //     restores the unconditional-getUser() behavior without a code revert
  //     (staged rollout / instant fallback if the local path misbehaves in
  //     beta).
  //
  //     PKCE safety: /api/auth/* routes are exempt from session verification
  //     entirely (neither getClaims nor getUser runs). auth-js
  //     _removeSession() clears the PKCE code_verifier from removedItems
  //     BEFORE firing SIGNED_OUT, so applyServerStorage includes the
  //     code_verifier deletion in its setAll call. The middleware setAll calls
  //     req.cookies.set("...-code-verifier", "") which zeroes the cookie in
  //     the forwarded Cookie header. The callback handler then reads an empty
  //     value, combineChunks returns null (falsy), and exchangeCodeForSession
  //     throws AuthPKCECodeVerifierMissingError. Auth routes manage their own
  //     session state and do not need server-side refresh.
  const { supabase, applyRefreshedSession } = createMiddlewareClient(req);
  let authUser: { id: string } | null = null;
  let sessionError: unknown = null;
  if (!pathname.startsWith("/api/auth/")) {
    if (process.env.AUTH_MIDDLEWARE_LOCAL_VERIFY_DISABLED !== "true") {
      try {
        const identity = await verifyIdentity(supabase);
        if (identity) authUser = { id: identity.authUserId };
      } catch {
        // Exotic decode failure — fall through to the authoritative path.
      }
    }
    if (!authUser) {
      const sessionResult = await supabase.auth.getUser();
      authUser = sessionResult.data.user;
      sessionError = sessionResult.error;
    }
  }

  // 1b-heal (§17.x, #1361) — self-heal a present-but-invalid session. When the
  //   request carries an auth cookie but getUser() DEFINITIVELY rejects it (a
  //   bad/expired/rotated refresh token — not a transient auth-server blip),
  //   delete the dead cookie so the browser stops replaying it, then send the
  //   user to re-authenticate. Without this the stale cookie fails on every
  //   subsequent request and fail-closed gates (e.g. /admin) wedge at an opaque
  //   404. isInvalidSessionError() screens out transient failures so a brief
  //   Supabase outage can't mass-log-out everyone. Runs before the admin/login
  //   gates so a bad-cookie visitor re-auths instead of hitting a 404. The
  //   re-auth surface itself (isAuthFlowPath) is cleared but not redirected, to
  //   avoid a loop. sessionError is populated ONLY by the getUser() handoff
  //   (see §1b) — a locally-verified session can never reach this block.
  //
  //   Two error shapes are definitively dead here (both require an auth cookie
  //   to be PRESENT, which is what separates them from the anonymous case):
  //   - AuthApiError (isInvalidSessionError): the server rejected the token —
  //     the pre-#1932 shape, still produced when the kill switch routes
  //     straight to getUser() and the refresh fails there.
  //   - AuthSessionMissingError: a cookie exists but yields no session. This
  //     is what the handoff getUser() reports after a dead-refresh failure
  //     inside getClaims already ran _removeSession (§1b), and what an
  //     unparseable/truncated session cookie has always produced. Session
  //     resolution from cookies is local and deterministic — a transient
  //     auth-server blip can NOT produce this shape (that surfaces as
  //     AuthRetryableFetchError, which heals nothing).
  if (
    !authUser &&
    hasSupabaseAuthCookie(req) &&
    (isInvalidSessionError(sessionError) ||
      isAuthSessionMissingError(sessionError))
  ) {
    // Both returns skip applyRefreshedSession by design: a failed getUser()
    // never ran the middleware setAll, so there are no rotated tokens to flush —
    // clearAuthCookies is the only Set-Cookie we want here.
    if (isAuthFlowPath(pathname)) {
      const res = NextResponse.next({ request: { headers: cloneAndScrubHeaders(req) } });
      clearAuthCookies(req, res);
      return res;
    }
    const url = req.nextUrl.clone();
    url.pathname = "/auth/reauth";
    url.search = `?return=${encodeURIComponent(pathname + (req.nextUrl.search || ""))}`;
    const res = NextResponse.redirect(url);
    clearAuthCookies(req, res);
    return res;
  }

  const host = req.headers.get("host") ?? "";
  // Strip port for local dev comparisons.
  const hostname = host.replace(/:\d+$/, "");

  const primaryDomain = process.env.PLATFORM_PRIMARY_DOMAIN ?? "";
  const domainRegex = process.env.PLATFORM_DOMAIN_REGEX ?? "";

  // 1c. Admin PAGE gate (§26, defense-in-depth; authoritative check is in
  //     (admin)/layout.tsx via assertPlatformAdmin). Admin pages live only on
  //     the platform host and require a session cookie. Anything else — a
  //     tenant/custom host, or no session cookie — gets a 404 so the admin
  //     surface is never disclosed to anonymous or cross-host callers and the
  //     service-role server components never run for them. The cookie here is
  //     only shape-checked (presence of sb-<ref>-auth-token); membership in
  //     platform_admins is verified authoritatively by the layout.
  if (
    isAdminPagePath(pathname) &&
    (hostname !== primaryDomain || !hasSupabaseAuthCookie(req))
  ) {
    return applyRefreshedSession(notFound());
  }

  // 1d. Login gate (§#1050) — redirect unauthenticated visitors on gated paths
  //     to /auth/reauth with a safe return path. Runs before tenant resolution
  //     so unauthenticated deep-links skip the DB lookup entirely. Applies on
  //     all domains: /signup/complete on the platform domain, /onboarding/* on
  //     tenant subdomains. The /auth/reauth page renders relative OAuth links
  //     so it establishes the session on whatever domain serves it.
  if (isLoginGatedPath(pathname) && !authUser) {
    const returnTo = pathname + (req.nextUrl.search || "");
    const url = req.nextUrl.clone();
    url.pathname = "/auth/reauth";
    url.search = `?return=${encodeURIComponent(returnTo)}`;
    return applyRefreshedSession(NextResponse.redirect(url));
  }

  // 2. Platform admin domain.
  //
  // Non-internal-tenant staff are redirected to their tenant subdomain (or
  // custom domain) so they always work in the correct context. The
  // is_platform_internal flag distinguishes real SaaS tenants from the
  // platform's own default tenant (used by platform admins). Falls through on
  // DB error, no tenant, or missing slug so the fallback sentinel still fires.
  //
  // For platform admins and anyone the redirect doesn't fire for, chat-adjacent
  // and console paths get a resolved tenant header instead of the sentinel.
  if (hostname === primaryDomain) {
    const headers = cloneAndScrubHeaders(req);

    // Redirect non-internal-tenant authenticated staff to their subdomain.
    // Excluded: admin/auth/login-gated paths (platform-domain-only flows) and
    // /api/* (browsers don't follow redirects transparently on fetch).
    if (
      authUser &&
      !isAdminPagePath(pathname) &&
      !isAuthFlowPath(pathname) &&
      !isLoginGatedPath(pathname) &&
      !pathname.startsWith("/api/")
    ) {
      try {
        const tenant = await getTenantByAuthUserId(authUser.id);
        if (tenant && !tenant.is_platform_internal) {
          const targetHost =
            tenant.custom_domain ??
            (tenant.slug ? `${tenant.slug}.${primaryDomain}` : "");
          if (targetHost) {
            const url = req.nextUrl.clone();
            url.hostname = targetHost;
            return applyRefreshedSession(NextResponse.redirect(url, { status: 302 }));
          }
        }
      } catch {
        // DB error — fall through to platform-domain handling.
      }
    }

    const isChatPath = matchesAnyPrefix(pathname, [
      ...CHAT_PAGE_PREFIXES,
      ...CHAT_API_PREFIXES,
    ]);

    // Tenant console and workspace paths that require a resolved tenant ID.
    // /admin/* is intentionally excluded — those routes use the "platform" sentinel.
    // Classification lives in route-classification.ts (#1601); the walk test
    // there fails CI when a new tenant-scoped route isn't declared.
    const isConsolePath = matchesAnyPrefix(pathname, [
      ...CONSOLE_PAGE_PREFIXES,
      ...CONSOLE_API_PREFIXES,
    ]);

    if ((isChatPath || isConsolePath) && authUser) {
      try {
        const tenant = await getTenantByAuthUserId(authUser.id);
        if (tenant) {
          headers.set(RESOLVED_TENANT_ID_HEADER, tenant.id);
          headers.set(RESOLVED_TENANT_TYPE_HEADER, tenant.tenant_type);
          const res = NextResponse.next({ request: { headers } });
          applyAttributionCapture(res, req);
          return applyRefreshedSession(applyPaymentGate(res, req, tenant));
        }
      } catch {
        // DB error — fall through to "platform" sentinel.
      }
    }

    headers.set(RESOLVED_TENANT_ID_HEADER, "platform");
    headers.set(RESOLVED_TENANT_TYPE_HEADER, "platform");
    return applyRefreshedSession(NextResponse.next({ request: { headers } }));
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
          return applyRefreshedSession(applyPaymentGate(res, req, tenant));
        }
      } catch {
        // DB error — fall through to 404. Don't leak DB error details.
      }
      return applyRefreshedSession(notFound());
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
      return applyRefreshedSession(applyPaymentGate(res, req, tenant));
    }
  } catch {
    // DB error — fall through to 404.
  }

  // 5. Vercel preview deploys — *.vercel.app hostnames belong to no tenant, so
  //    steps 2-4 all miss and the deploy would 404. In NON-production only
  //    (VERCEL_ENV !== "production"), map them to the configured default tenant
  //    (PLATFORM_DEFAULT_TENANT_ID) so PR previews render a usable tenant
  //    experience. Gated to non-production so production *.vercel.app URLs still
  //    404 and the T7 test-auth-bypass surface (test-bypass.ts, also VERCEL_ENV-
  //    gated) is unaffected. Previews stay behind Vercel Deployment Protection,
  //    so this is reachable only by the Vercel team, not the public.
  if (
    process.env.VERCEL_ENV !== "production" &&
    hostname.endsWith(".vercel.app")
  ) {
    const defaultTenantId = process.env.PLATFORM_DEFAULT_TENANT_ID;
    if (defaultTenantId) {
      try {
        const tenant = await getTenantById(defaultTenantId);
        if (tenant) {
          const headers = cloneAndScrubHeaders(req);
          headers.set(RESOLVED_TENANT_ID_HEADER, tenant.id);
          headers.set(RESOLVED_TENANT_TYPE_HEADER, tenant.tenant_type);
          const res = NextResponse.next({ request: { headers } });
          applyAttributionCapture(res, req);
          return applyRefreshedSession(applyPaymentGate(res, req, tenant));
        }
      } catch {
        // DB error — fall through to 404. Don't leak DB error details.
      }
    }
  }

  return applyRefreshedSession(notFound());
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
