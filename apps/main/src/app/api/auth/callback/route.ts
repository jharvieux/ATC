// §17.1 / §17.2 / §17.3 — OAuth callback handler.
//
// Handles PKCE code exchange for Google, Microsoft (azure), and Facebook.
// Apple is explicitly deferred (§17.1).
//
// After exchange: resolves the Microsoft no-email chain (§17.2),
// upserts the public.users row, then redirects to:
//   - /signup/email-prompt  when Microsoft yields no email
//   - /                     otherwise (consent check is client-side)

import { createClient } from "@supabase/supabase-js";
import { recoverMicrosoftEmail } from "@/lib/auth/microsoft-email-recovery";
import { tenantContextFromRequest } from "@/lib/db/factories";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    const desc = url.searchParams.get("error_description") ?? "OAuth failed";
    return redirectTo(req, `/auth/error?message=${encodeURIComponent(desc)}`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error: exchangeErr } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeErr || !data.session) {
    return redirectTo(req, `/auth/error?message=${encodeURIComponent(exchangeErr?.message ?? "Session exchange failed")}`);
  }

  const session = data.session;
  const authUser = session.user;
  const provider = authUser.app_metadata?.provider as string | undefined;
  let email: string | null = authUser.email ?? null;

  // §17.2 — Microsoft no-email recovery chain.
  if (provider === "azure") {
    const accessToken = (session.provider_token as string | undefined) ?? session.access_token;
    email = await recoverMicrosoftEmail(email, accessToken);
    if (!email) {
      // Send user to email-prompt page; carry the access token in a short cookie.
      const headers = new Headers({ Location: "/signup/email-prompt" });
      headers.set(
        "Set-Cookie",
        `_ms_session=${session.access_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`,
      );
      return new Response(null, { status: 302, headers });
    }
  }

  // Upsert public.users row for the resolved tenant context.
  try {
    const ctx = await tenantContextFromRequest(req);
    const svc = createServiceRoleClient();
    await svc.from("users").upsert(
      { auth_user_id: authUser.id, tenant_id: ctx.tenant_id, email: email ?? "", status: "active" },
      { onConflict: "auth_user_id,tenant_id", ignoreDuplicates: false },
    );
  } catch {
    // Non-fatal: tenant context may not resolve from this request's origin;
    // user row creation falls back to the signup flow client-side.
  }

  return redirectTo(req, "/");
}

function redirectTo(req: Request, path: string): Response {
  const base = new URL(req.url);
  return Response.redirect(`${base.protocol}//${base.host}${path}`, 302);
}
