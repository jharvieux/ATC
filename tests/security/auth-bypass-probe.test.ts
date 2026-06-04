/**
 * §30.8 — Auth-bypass static probe.
 *
 * Catches the most common auth-bypass bug: a route handler that simply
 * forgets to call any auth/permission helper at all. The probe enumerates
 * every `apps/main/src/app/api/** /route.ts` and asserts each one imports
 * at least one of the allowed authority helpers.
 *
 * Genuinely public routes (health check, unsubscribe link, public webhook
 * endpoints with their own signature checks) live on the allowlist below
 * with a reason — that's the audit surface.
 *
 * Beyond static import-checking, the auth-bypass behavior itself is
 * covered by:
 *   - apps/main/test/unit/auth/assert-permission.test.ts — AuthReauthRequired
 *     when JWT auth_time exceeds the §26.3 4h window for sensitive routes.
 *   - Webhook signature verification is covered by each webhook handler's
 *     own unit tests (Stripe, Resend, Inngest).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { enumerateRoutes, type RouteEntry } from "../../scripts/enumerate-api-routes";

const REPO_ROOT = join(__dirname, "..", "..");
const API_ROOT = join(REPO_ROOT, "apps", "main", "src", "app", "api");

/**
 * Tokens whose presence in a route's source file proves it consults SOME
 * authority surface. The probe doesn't model which surface is correct for
 * a given route — only that the route doesn't skip auth wholesale.
 */
const AUTH_TOKENS = [
  "assertPermission",
  "withPlatformAdminAudit",
  "platformAdminClient",
  "tenantClient",
  "tenantContextFromRequest",
  "tenantContextFromStripeEvent",
  "tenantContextFromResendEvent",
  "tenantContextFromInngestEvent",
  "createServiceRoleClient",
  // Inbound webhook signature checks — each handler verifies these inline.
  "verifyStripeWebhook",
  "verifyResendWebhook",
  "verifyServiceJwt",
  "constructEvent", // Stripe SDK signature verification helper
  "verifyInngestSignature",
  // Anonymous-session and rate-limit gates (still an authority surface).
  "resolveAnonymousSession",
  "checkAnonymousChatLimit",
  // OAuth callback uses code-for-session exchange via supabase.auth.exchangeCodeForSession.
  "exchangeCodeForSession",
  // Token-bearing routes whose authority is the HMAC-signed token itself.
  "verifyInvitationToken",
  "verifyCompanionToken",
  "verifyUnsubscribeToken",
  // Stripe webhook delegate — both stripe webhook routes hand off to this.
  "handleStripeWebhook",
  // OTP-driven flows (signup email verification, no-email Microsoft fallback).
  "OTP_STORE",
  // Supabase OAuth initiation (authority is the OAuth provider, not us).
  "signInWithOAuth",
  // Low-level platform-admin auth primitive. Always paired with withPlatformAdminAudit
  // in routes that perform DB operations; used standalone only for fire-and-forget dispatches
  // where the audit wrapper's DB callback isn't needed.
  "assertPlatformAdmin",
] as const;

/**
 * Routes that are intentionally public. Every entry needs a reason; the
 * test prints the reason in any failure for traceability.
 */
const PUBLIC_ROUTE_ALLOWLIST: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\/health\/route\.ts$/,
    reason: "§30.5 — uptime health check; intentionally unauthenticated",
  },
  {
    pattern: /\/legal\/\[doctype\]\/current\/route\.ts$/,
    reason: "§17.5 — public read of current legal doc versions",
  },
  {
    pattern: /\/tenants\/slug-check\/route\.ts$/,
    reason: "§17.0 — public slug-availability check during signup",
  },
  {
    pattern: /\/api\/auth\/callback\/route\.ts$/,
    reason: "OAuth callback; authority is the OAuth code-for-session exchange",
  },
  {
    pattern: /\/api\/email\/unsubscribe\/route\.ts$/,
    reason: "§23 unsubscribe link; authority is the HMAC-signed token in the URL",
  },
  {
    pattern: /\/api\/groups\/invite\/\[token\]\//,
    reason: "§18 group invite landing; authority is the HMAC-signed token",
  },
  {
    pattern: /\/api\/pricing\/preview\/route\.ts$/,
    reason: "§3.3 public pricing preview used by the signup wizard",
  },
  {
    pattern: /\/api\/webhooks\/gmailpubsub\/route\.ts$/,
    reason: "§23.9 Gmail Pub/Sub handler — currently a 501 stub; revisit when implementation lands",
  },
  {
    pattern: /\/api\/security\/csp-report\/route\.ts$/,
    reason:
      "#572 CSP violation collector; intentionally unauthenticated (browsers POST reports directly with no credentials). " +
      "Makes no allow/deny decision and no DB write — abuse-resistant via content-type + body-size gates and log de-dup.",
  },
  {
    pattern: /\/api\/travel-news\/route\.ts$/,
    reason:
      "§TN — public travel news ticker; read-only, no PII. Deny-all RLS on authenticated roles; " +
      "service-role read filtered to relevance_score≥60 non-hidden articles only.",
  },
];

function findAuthTokensInSource(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const found: string[] = [];
  for (const token of AUTH_TOKENS) {
    if (src.includes(token)) found.push(token);
  }
  return found;
}

function allowlistReason(filePath: string): string | null {
  const rel = relative(REPO_ROOT, filePath);
  for (const entry of PUBLIC_ROUTE_ALLOWLIST) {
    if (entry.pattern.test(rel)) return entry.reason;
  }
  return null;
}

describe("§30.8 auth-bypass static probe", () => {
  let routeFiles: string[] = [];

  beforeAll(() => {
    // enumerateRoutes returns one entry per HTTP-method export. Collapse
    // to a unique set of source files — auth is per-file, not per-method.
    const seen = new Set<string>();
    for (const r of enumerateRoutes(API_ROOT) as RouteEntry[]) {
      // Reconstruct file path from r.path.
      const rel = r.path.replace(/^\/api\//, "").replace(/^\/+/, "");
      const filePath = join(API_ROOT, rel, "route.ts");
      seen.add(filePath);
    }
    routeFiles = [...seen].sort();
  });

  it("enumerates at least 30 route files (sanity)", () => {
    // We have ~120 route files today (post-BP28). A wildly low count means
    // the enumerator broke or the api/ tree moved.
    expect(routeFiles.length).toBeGreaterThan(30);
  });

  it("every route file either imports an auth token or is on the public allowlist", () => {
    const offenders: string[] = [];
    for (const filePath of routeFiles) {
      try {
        const tokens = findAuthTokensInSource(filePath);
        if (tokens.length > 0) continue; // route consults an authority surface
        const reason = allowlistReason(filePath);
        if (reason) continue; // intentionally public
        offenders.push(relative(REPO_ROOT, filePath));
      } catch (err) {
        // Missing file (enumerator path mismatch) — surface, don't silently skip.
        offenders.push(
          `${relative(REPO_ROOT, filePath)}: could not read (${(err as Error).message})`,
        );
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Auth-bypass probe failures — these routes import no auth helper AND are not on the public allowlist:\n` +
          offenders.map((o) => `  - ${o}`).join("\n") +
          `\n\nFix by either: (a) adding an auth check (assertPermission / withPlatformAdminAudit / tenantContextFromRequest / etc.),` +
          ` or (b) adding the file to PUBLIC_ROUTE_ALLOWLIST in this test with a reason if it is genuinely public.`,
      );
    }
  });

  it("every PUBLIC_ROUTE_ALLOWLIST entry actually matches at least one route file (catches stale allowlist)", () => {
    const stale: string[] = [];
    for (const entry of PUBLIC_ROUTE_ALLOWLIST) {
      const matched = routeFiles.some((f) =>
        entry.pattern.test(relative(REPO_ROOT, f)),
      );
      if (!matched) stale.push(entry.pattern.toString());
    }
    if (stale.length > 0) {
      throw new Error(
        `PUBLIC_ROUTE_ALLOWLIST contains entries that match no current route file:\n` +
          stale.map((s) => `  - ${s}`).join("\n") +
          `\nRemove the stale entries so the allowlist stays a true map of public surface.`,
      );
    }
  });
});

describe("§26.3 sensitive-actions re-auth wiring", () => {
  it("AuthReauthRequired is exported from assert-permission (BP26 contract)", async () => {
    const mod = await import("@/lib/auth/assert-permission");
    expect(mod.AuthReauthRequired).toBeDefined();
    expect(typeof mod.AuthReauthRequired).toBe("function"); // class constructor
  });

  it("AuthReauthRequired carries the structured shape callers depend on", async () => {
    // Smoke construct — code/return_to are what route handlers convert
    // into the 401 response body so the client can re-auth and resume.
    // The class shape is stable; callers do `catch (e) if e instanceof AuthReauthRequired`.
    // (No runtime stale-JWT integration test here — that lives in the
    //  assert-permission unit test file with the auth_time clock fixture.)
    const mod = await import("@/lib/auth/assert-permission");
    const cls = mod.AuthReauthRequired as unknown as new (
      msg: string,
      opts: { code: string; return_to: string },
    ) => Error;
    const e = new cls("stale", { code: "reauth_required", return_to: "/settings/x" });
    expect(e).toBeInstanceOf(Error);
    expect((e as unknown as { code: string }).code).toBe("reauth_required");
  });
});
