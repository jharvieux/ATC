"use client";

// §26 — Shared client-side helper for calling /api/admin/* routes.
//
// Reads the current Supabase session token from the browser-side Supabase
// client (which loads it from localStorage where the OAuth callback wrote
// it) and sends it as Authorization: Bearer. The route's middleware gate
// then accepts it as a JWT shape, and the handler's assertPlatformAdmin()
// verifies the JWT and checks platform_admins.
//
// Prior to this helper, admin React pages each defined their own local
// adminFetch that sent the unauthenticated x-admin-user-id header — that
// was audit Finding 1 (HIGH, confidence 10).
//
// USAGE:
//   import { adminFetch } from "@/lib/admin-fetch";
//   const r = await adminFetch("/api/admin/help/bugs");
//   if (r.status === 401) navigateToLogin();
//   if (r.status === 403) showNotAnAdminMessage();

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return cachedClient;
}

export async function adminFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;

  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}
