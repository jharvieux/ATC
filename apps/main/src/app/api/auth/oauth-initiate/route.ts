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
import { safeNextFor } from "@/lib/auth/safe-redirect";

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

  // Optional post-login destination (e.g. the reauth `return` path).
  // Validated by parsing the raw input against our origin and checking
  // `parsed.origin === url.origin` — see lib/auth/safe-redirect.ts for
  // why this beats the prior startsWith-shape predicate.
  const safe = safeNextFor(url.searchParams.get("redirect_to"), url.origin);

  const callbackUrl = new URL("/api/auth/callback", url.origin);
  if (safe) callbackUrl.searchParams.set("next", safe.path);

  const { supabase, applyAuthCookies } = createRouteHandlerClient(req);

  // Do NOT set options.queryParams.state — `state` is reserved by Supabase's
  // PKCE/CSRF flow. Overriding it makes Supabase reject the provider callback
  // with "OAuth state parameter is invalid" (prior bug, #438).
  // Azure requires explicit `email` scope — without it Microsoft omits the email
  // claim from the id_token and Supabase throws "Error getting user email from
  // external provider" before our callback even runs. `User.Read` is also added
  // so the Graph fallback in recoverMicrosoftEmail (§17.2) has a working token.
  // `prompt=select_account` forces the provider to show its account chooser
  // instead of silently reusing the browser's single live IdP session. Without
  // it, a user already signed into one Google/Microsoft account is bounced
  // straight back with that identity and can't pick a different one — which let
  // an agency get provisioned under the wrong account. Standard OIDC param,
  // honored by Google and Azure; Facebook ignores it harmlessly.
  const oauthOptions: Parameters<typeof supabase.auth.signInWithOAuth>[0]["options"] = {
    redirectTo: callbackUrl.toString(),
    queryParams: { prompt: "select_account" },
    ...(provider === "azure" && { scopes: "email User.Read" }),
  };
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: provider as "google" | "azure" | "facebook",
    options: oauthOptions,
  });

  if (error || !data.url) {
    return NextResponse.json(
      { error: "db_error", ref: crypto.randomUUID() },
      { status: 500 },
    );
  }

  // applyAuthCookies attaches the PKCE code_verifier cookie that
  // signInWithOAuth asked us to set, so the callback can complete the exchange.
  return applyAuthCookies(NextResponse.redirect(data.url, 302));
}
