// §22.9 — Public config endpoint for the browser extension.
//
// Returns the Supabase project URL and anon key so the extension can
// authenticate without requiring the user to know these values. Both
// are NEXT_PUBLIC_* (already in the JS bundle) so exposing them here
// is not a secret disclosure.

import { corsOptionsResponse, EXTERNAL_CLIENT_CORS_HEADERS } from "@/lib/http/cors";

export function OPTIONS(): Response {
  return corsOptionsResponse();
}

export function GET(): Response {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return Response.json(
      { error: "platform_not_configured" },
      { status: 503, headers: EXTERNAL_CLIENT_CORS_HEADERS },
    );
  }

  return Response.json(
    { supabase_url: supabaseUrl, supabase_anon_key: supabaseAnonKey },
    { headers: EXTERNAL_CLIENT_CORS_HEADERS },
  );
}
