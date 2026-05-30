// §17.1 / §17.3 — OAuth initiation (PKCE).
//
// Builds the Supabase OAuth authorize URL via the @supabase/ssr server client
// and 302-redirects to the provider. @supabase/ssr uses the PKCE flow: a
// code_verifier is generated during signInWithOAuth and written to an HttpOnly
// cookie here, then read back by the callback's exchangeCodeForSession. The
// prior implicit-flow client returned tokens in the URL fragment and never
// established a server session (the #access_token=... redirect bug).
//
// Providers: Google, Microsoft (azure), Facebook. Apple is deferred (§17.1).

import { NextResponse, type NextRequest } from "next/server";
import { createRouteHandlerClient } from "@/lib/auth/ssr-client";
import { isSafePostLoginPath } from "@/lib/auth/safe-redirect";

const ALLOWED_PROVIDERS = new Set(["google", "azure", "facebook"]);

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");

  if (!provider || !ALLOWED_PROVIDERS.has(provider)) {
    return NextResponse.json(
      { error: "Invalid or unsupported OAuth provider" },
      { status: 400 },
    );
  }

  // Optional post-login destination (e.g. the reauth `return` path). Forwarded
  // as ?next= on the callback URL and honored after the session is established
  // (closes #437). Validated to a same-app relative path; unsafe/auth-internal
  // values are dropped and the callback falls back to "/".
  const requestedNext = url.searchParams.get("redirect_to");
  const next =
    requestedNext && isSafePostLoginPath(requestedNext) ? requestedNext : null;

  const callbackUrl = new URL("/api/auth/callback", url.origin);
  if (next) callbackUrl.searchParams.set("next", next);

  const { supabase, applyAuthCookies } = createRouteHandlerClient(req);

  // Do NOT set options.queryParams.state — `state` is reserved by Supabase's
  // PKCE/CSRF flow. Overriding it makes Supabase reject the provider callback
  // with "OAuth state parameter is invalid" (prior bug, #438).
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: provider as "google" | "azure" | "facebook",
    options: { redirectTo: callbackUrl.toString() },
  });

  if (error || !data.url) {
    return NextResponse.json(
      { error: error?.message ?? "Could not initiate OAuth" },
      { status: 500 },
    );
  }

  // applyAuthCookies attaches the PKCE code_verifier cookie that
  // signInWithOAuth asked us to set, so the callback can complete the exchange.
  return applyAuthCookies(NextResponse.redirect(data.url, 302));
}
