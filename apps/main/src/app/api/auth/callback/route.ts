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
//     domain the resolved id is the "platform" sentinel — net-new tenant
//     provisioning is deferred (#441), so we only establish the session.
//   - Redirect to the validated ?next= (forwarded by oauth-initiate) or "/".

import { NextResponse, type NextRequest } from "next/server";
import { createRouteHandlerClient } from "@/lib/auth/ssr-client";
import { recoverMicrosoftEmail } from "@/lib/auth/microsoft-email-recovery";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { safeNextFor } from "@/lib/auth/safe-redirect";

const RESOLVED_TENANT_ID_HEADER = "x-resolved-tenant-id";

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
    return applyAuthCookies(
      NextResponse.redirect(new URL("/signup/email-prompt", url.origin), 302),
    );
  }

  // Membership upsert. On a tenant domain the resolved id is a UUID — use
  // it directly. On the platform domain the resolved id is the "platform"
  // sentinel; if PLATFORM_DEFAULT_TENANT_ID is configured, assign the user
  // to that agency so platform-domain sign-ins result in a real membership
  // row rather than a session with no tenant. Without the env var the upsert
  // is skipped (legacy behaviour, #441).
  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  const effectiveTenantId =
    tenantId === "platform" || !tenantId
      ? (process.env.PLATFORM_DEFAULT_TENANT_ID ?? null)
      : tenantId;
  if (effectiveTenantId) {
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

  // Parse-then-check-origin (see lib/auth/safe-redirect.ts). The parser
  // — not a startsWith chain — decides the host, so userinfo / fullwidth /
  // encoded-slash tricks all fail the parsed.origin equality.
  const safe = safeNextFor(url.searchParams.get("next"), url.origin);
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
