"use client";

// §26 — Shared client-side helper for calling /api/admin/* routes.
//
// §17.x moved the session to HttpOnly cookies, which travel automatically
// on same-origin fetches — there's no Bearer to attach (and no localStorage
// session to read; HttpOnly cookies aren't visible to JS by design). The
// middleware gate detects the auth cookie; assertPlatformAdmin then
// verifies it server-side via @supabase/ssr and checks platform_admins.
//
// Prior to the shared helper, admin React pages each defined their own
// local adminFetch that sent the unauthenticated x-admin-user-id header
// (audit Finding 1, HIGH, confidence 10) — that's what this still exists
// to crowd out.
//
// USAGE:
//   import { adminFetch } from "@/lib/admin-fetch";
//   const r = await adminFetch("/api/admin/help/bugs");
//   if (r.status === 401) navigateToLogin();
//   if (r.status === 403) showNotAnAdminMessage();

export async function adminFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}
