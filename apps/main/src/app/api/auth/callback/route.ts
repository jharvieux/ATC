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
import { isSafePostLoginPath } from "@/lib/auth/safe-redirect";

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
    if (!email) {
      // Auth succeeded; we just lack an email. Establish the session AND carry
      // a short marker so /signup/email-prompt can finalize the users row.
      const res = NextResponse.redirect(
        new URL("/signup/email-prompt", url.origin),
        302,
      );
      res.cookies.set({
        name: "_ms_session",
        value: session.access_token,
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 900,
      });
      return applyAuthCookies(res);
    }
  }

  // Membership upsert — tenant domains only. On the platform domain the
  // resolved id is the "platform" sentinel; provisioning a net-new tenant is
  // deferred (#441) and the session is still established below.
  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  if (tenantId && tenantId !== "platform") {
    const svc = createServiceRoleClient();
    await safeAwait(
      svc.from("users").upsert(
        {
          auth_user_id: authUser.id,
          tenant_id: tenantId,
          email: email ?? "",
          status: "active",
        },
        { onConflict: "auth_user_id,tenant_id", ignoreDuplicates: false },
      ),
      "auth.callback.users.upsert",
    );
  }

  const requestedNext = url.searchParams.get("next");
  const next =
    requestedNext && isSafePostLoginPath(requestedNext) ? requestedNext : "/";
  return applyAuthCookies(
    NextResponse.redirect(new URL(next, url.origin), 302),
  );
}

function errorRedirect(url: URL, message: string): Response {
  const target = new URL("/auth/error", url.origin);
  target.searchParams.set("message", message);
  return NextResponse.redirect(target, 302);
}
