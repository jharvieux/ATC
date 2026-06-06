// §17.2 Step 6 — no-email recovery: OTP verification + users-row finalize.
//
// Flow: POST /api/auth/microsoft-email-verify { code }
//   → reads _ms_pending_email cookie (the email the user typed in step 4)
//   → looks up the OTP via OTP_STORE keyed by that email
//   → validates code matches + not expired + under the attempt cap
//   → resolves auth_user_id from the cookie session set by /api/auth/callback
//   → persists the verified email onto the auth user (admin API) so
//     /signup/complete + other auth.email readers see it (#441)
//   → upserts public.users (viewer) into the tenant / default tenant, EXCEPT on
//     the agency flow — that's left to /signup/complete to provision
//   → clears the OTP cookies and returns to the carried next (/signup/complete) or "/"
//
// Provider-neutral despite the route name: the same recovery handles MS
// when Graph turns up nothing AND any other provider (Facebook, future) that
// yields a null email. Rename deferred to avoid a file-move during the
// auth migration PR.

import { NextResponse, type NextRequest } from "next/server";
import { OTP_STORE, MAX_OTP_ATTEMPTS } from "@/lib/auth/otp-store";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { safeNextFor } from "@/lib/auth/safe-redirect";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

const PENDING_EMAIL_COOKIE = "_ms_pending_email";
// Set by the OAuth callback on the null-email bounce; carries the agency
// destination (/signup/complete) across the OTP round-trip (#441).
const PENDING_NEXT_COOKIE = "_ms_pending_next";

// In-process IP rate limiter — 10 attempts per IP per 15 minutes.
// Per-instance only (no Redis); acceptable for the low-concurrency §17.2 OTP
// flow. An attacker cycling instances still sees the per-email MAX_OTP_ATTEMPTS
// cap in OTP_STORE. Multi-instance Redis upgrade tracked in #735.
const OTP_IP_WINDOW_MS = 15 * 60 * 1000;
const OTP_IP_LIMIT = 10;
// Opportunistic sweep threshold: evict stale entries when the map exceeds this
// size, preventing unbounded growth from IPs that hit once and never return.
const OTP_IP_SWEEP_THRESHOLD = 1000;
interface IpEntry { count: number; windowStart: number }
const ipAttempts = new Map<string, IpEntry>();

function checkOtpIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipAttempts.get(ip);
  if (!entry || now - entry.windowStart > OTP_IP_WINDOW_MS) {
    if (ipAttempts.size > OTP_IP_SWEEP_THRESHOLD) {
      for (const [k, v] of ipAttempts) {
        if (now - v.windowStart > OTP_IP_WINDOW_MS) ipAttempts.delete(k);
      }
    }
    ipAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= OTP_IP_LIMIT) return false;
  entry.count += 1;
  return true;
}

export function _resetIpAttemptsForTests(): void {
  ipAttempts.clear();
}

export async function POST(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    // "unknown" bucket is intentional fail-closed: callers without forwarded
    // headers (misconfigured edge, direct invocation) share one bucket and
    // exhaust the limit together. Vercel always sets x-forwarded-for in prod.
    "unknown";
  if (!checkOtpIpRateLimit(ip)) {
    return errorRedirect(url, "Too many verification attempts. Please try again in 15 minutes.");
  }

  const form = await req.formData();
  const code = (form.get("code") as string | null)?.trim() ?? "";

  const pendingEmail = req.cookies.get(PENDING_EMAIL_COOKIE)?.value;
  if (!pendingEmail) {
    return errorRedirect(
      url,
      "Verification session expired. Please sign in again.",
    );
  }

  if (!/^\d{6}$/.test(code)) {
    return errorRedirect(url, "Enter the 6-digit code from your email.");
  }

  const stored = OTP_STORE.get(pendingEmail);
  if (!stored || stored.expires < Date.now()) {
    OTP_STORE.delete(pendingEmail);
    return errorRedirect(
      url,
      "Verification code expired. Please request a new one.",
    );
  }
  if (stored.attempts >= MAX_OTP_ATTEMPTS) {
    OTP_STORE.delete(pendingEmail);
    return errorRedirect(
      url,
      "Too many attempts. Please request a new code.",
    );
  }
  if (stored.code !== code) {
    stored.attempts += 1;
    OTP_STORE.set(pendingEmail, stored);
    return errorRedirect(url, "Verification code is incorrect.");
  }
  OTP_STORE.delete(pendingEmail);

  // Resolve the auth user from the cookie session set by /api/auth/callback.
  const supabase = createRequestScopedClient(req);
  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    return errorRedirect(url, "Session expired. Please sign in again.");
  }

  // Persist the OTP-verified email onto the auth user. Until now auth.users.email
  // is null (that's why we ran the OTP), so /signup/complete and every other
  // auth.email reader would still see null — and the user would re-OTP on every
  // future login. admin.updateUserById + email_confirm sets it directly (no
  // confirmation round-trip) because we already proved ownership via the OTP.
  const svc = createServiceRoleClient();
  const { error: emailErr } = await svc.auth.admin.updateUserById(
    authData.user.id,
    { email: pendingEmail, email_confirm: true },
  );
  if (emailErr) {
    return errorRedirect(
      url,
      "We couldn't finish verifying that email — it may already be linked to another account.",
    );
  }

  // Membership upsert — mirrors the OAuth callback (#441): on a tenant domain use
  // the UUID; on the platform domain use PLATFORM_DEFAULT_TENANT_ID when set.
  // Role is omitted so the column default ('viewer') applies on INSERT. The
  // agency flow (next=/signup/complete) skips the upsert so /signup/complete's
  // idempotency guard can provision a fresh tenant (#800).
  const next = safeNextFor(req.cookies.get(PENDING_NEXT_COOKIE)?.value, url.origin);
  const isAgencyProvisioning =
    next !== null && new URL(next.path, url.origin).pathname === "/signup/complete";
  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  const effectiveTenantId =
    tenantId === "platform" || !tenantId
      ? (process.env.PLATFORM_DEFAULT_TENANT_ID ?? null)
      : tenantId;
  if (effectiveTenantId && !isAgencyProvisioning) {
    await safeAwait(
      svc.from("users").upsert(
        {
          auth_user_id: authData.user.id,
          tenant_id: effectiveTenantId,
          email: pendingEmail,
          status: "active",
        },
        { onConflict: "auth_user_id,tenant_id", ignoreDuplicates: false },
      ),
      "auth.email_verify.users.upsert",
    );
  }

  // Return to the carried agency destination (/signup/complete) when present,
  // else home. Clear both OTP cookies.
  const target = next ? new URL(next.path, url.origin) : new URL("/", url.origin);
  const res = NextResponse.redirect(target, 302);
  res.cookies.set({ name: PENDING_EMAIL_COOKIE, value: "", path: "/", maxAge: 0 });
  res.cookies.set({ name: PENDING_NEXT_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}

function errorRedirect(url: URL, message: string): Response {
  const target = new URL("/auth/error", url.origin);
  target.searchParams.set("message", message);
  return NextResponse.redirect(target, 302);
}
