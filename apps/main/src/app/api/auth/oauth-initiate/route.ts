// §17.3 — OAuth initiation: builds the Supabase OAuth redirect URL and
// forwards the user to the provider. Handles Google, Microsoft (azure),
// and Facebook. Apple is explicitly deferred (§17.1).

import { createClient } from "@supabase/supabase-js";

const ALLOWED_PROVIDERS = new Set(["google", "azure", "facebook"]);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");

  if (!provider || !ALLOWED_PROVIDERS.has(provider)) {
    return Response.json({ error: "Invalid or unsupported OAuth provider" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const callbackUrl = new URL(req.url);
  callbackUrl.pathname = "/api/auth/callback";
  callbackUrl.search = "";

  // Do NOT set options.queryParams.state — `state` is reserved by Supabase's
  // PKCE/CSRF flow. Overriding it makes Supabase reject the provider callback
  // with "OAuth state parameter is invalid" (the prior bug here).
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: provider as "google" | "azure" | "facebook",
    options: { redirectTo: `${callbackUrl.origin}${callbackUrl.pathname}` },
  });

  if (error || !data.url) {
    return Response.json({ error: error?.message ?? "Could not initiate OAuth" }, { status: 500 });
  }

  return Response.redirect(data.url, 302);
}
