// §17.1 / §17.2 / §17.3 — OAuth callback handler (PKCE).
//
// Completes the PKCE code exchange via @supabase/ssr: reads the code_verifier
// cookie that oauth-initiate set, then writes the HttpOnly session cookies
// onto the redirect (applyAuthCookies) so the browser carries a real
// server-side session. The prior implicit-flow client returned tokens in the
// URL fragment and never established a session (the #access_token=... bug).
//
// After a successful exchange:
//   - Microsoft no-email chain (§17.2): if azure yields no usable email, stash
//     the provider token in a short cookie and send to /signup/email-prompt.
//   - On a TENANT domain (x-resolved-tenant-id is a UUID) upsert the
//     public.users membership row so the user can transact. On the PLATFORM
//     domain the resolved id is the "platform" sentinel; when
//     PLATFORM_DEFAULT_TENANT_ID is set the upsert runs into that tenant,
//     otherwise it is skipped (#441).
//   - Redirect to the validated ?next= (forwarded by oauth-initiate) or "/".

import { NextResponse, type NextRequest } from "next/server";
import { createRouteHandlerClient } from "@/lib/auth/ssr-client";
import { recoverMicrosoftEmail } from "@/lib/auth/microsoft-email-recovery";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { safeNextFor } from "@/lib/auth/safe-redirect";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

// Carries the agency-provisioning destination across the no-email OTP round-trip
// (callback → email-prompt → verify). The verify route reads it to return the
// user to /signup/complete (#441). Same cookie attrs as _ms_pending_email.
const PENDING_NEXT_COOKIE = "_ms_pending_next";

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (oauthError || !code) {
    const desc = url.searchParams.get("error_description") ?? "OAuth failed";
    return errorRedirect(url, desc);
  }

  const { supabase, applyAuthCookies } = createRouteHandlerClient(req);

  const { data, error: exchangeErr } =
    await supabase.auth.exchangeCodeForSession(code);
  if (exchangeErr || !data.session) {
    return errorRedirect(url, exchangeErr?.message ?? "Session exchange failed");
  }

  const session = data.session;
  const authUser = session.user;
  const provider = authUser.app_metadata?.provider as string | undefined;
  let email: string | null = authUser.email ?? null;

  // Resolve the post-login redirect once, up front: the null-email OTP bounce,
  // the membership-skip decision, and the final redirect all key off it. Compare
  // the PATHNAME, not safe.path (which is pathname + search + hash), so
  // next=/signup/complete?x=… still counts as the agency flow — otherwise the
  // membership upsert below would re-create the default-tenant row (#800).
  const safe = safeNextFor(url.searchParams.get("next"), url.origin);
  const isAgencyProvisioning =
    safe !== null && new URL(safe.path, url.origin).pathname === "/signup/complete";

  // §17.2 — Microsoft no-email recovery chain. The Graph calls need the
  // provider token (Microsoft's), not the Supabase JWT; fall back defensively.
  if (provider === "azure") {
    const graphToken =
      (session.provider_token as string | undefined) ?? session.access_token;
    email = await recoverMicrosoftEmail(email, graphToken);
  }

  // §17.2 generalized — Facebook (and any provider without a Graph-equivalent)
  // also yields null email when the user denies the email scope. Same OTP
  // recovery: establish the session and bounce to /signup/email-prompt where
  // the user types an email and confirms it via Resend OTP. The session is
  // already on the response (applyAuthCookies); the verify route reads it
  // back to identify the auth user.
  if (!email) {
    const res = applyAuthCookies(
      NextResponse.redirect(new URL("/signup/email-prompt", url.origin), 302),
    );
    // Carry the agency destination across the OTP round-trip so the verify step
    // returns the user to /signup/complete (#441). Without this the next= is lost
    // at the bounce and OTP users can never reach provisioning.
    if (safe) {
      res.cookies.set({
        name: PENDING_NEXT_COOKIE,
        value: safe.path,
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 600,
      });
    }
    return res;
  }

  // Membership upsert. On a tenant domain the resolved id is a UUID — use it
  // directly. On the platform domain the resolved id is the "platform" sentinel;
  // if PLATFORM_DEFAULT_TENANT_ID is configured, assign the user to that agency
  // (the platform's own customer tenant) so platform-domain sign-ins get a real
  // membership row. Without the env var the upsert is skipped (#441).
  //
  // Role is intentionally OMITTED so the column default ('viewer', least-priv —
  // migration 20260628000002) applies on INSERT. An explicit role here would
  // overwrite an existing owner/agent on the onConflict UPDATE (a real member
  // re-logging-in on their tenant subdomain) — see #800.
  //
  // Agency provisioning is the exception: a user heading to /signup/complete must
  // NOT get a membership row here, or that route's idempotency guard rejects them
  // as already_provisioned and they can never create their own tenant.
  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  const effectiveTenantId =
    tenantId === "platform" || !tenantId
      ? (process.env.PLATFORM_DEFAULT_TENANT_ID ?? null)
      : tenantId;
  if (effectiveTenantId && !isAgencyProvisioning) {
    const svc = createServiceRoleClient();
    await safeAwait(
      svc.from("users").upsert(
        {
          auth_user_id: authUser.id,
          tenant_id: effectiveTenantId,
          email: email ?? "",
          status: "active",
        },
        { onConflict: "auth_user_id,tenant_id", ignoreDuplicates: false },
      ),
      "auth.callback.users.upsert",
    );
  }

  const target = safe
    ? new URL(safe.path, url.origin)
    : new URL("/", url.origin);
  return applyAuthCookies(NextResponse.redirect(target, 302));
}

function errorRedirect(url: URL, message: string): Response {
  const target = new URL("/auth/error", url.origin);
  target.searchParams.set("message", message);
  return NextResponse.redirect(target, 302);
}
