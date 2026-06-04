// Helper to compute the SiteHeader props from the request that called a
// server component or layout. Keeps the auth-check + domain-check
// boilerplate in one place rather than duplicated across every page that
// renders the header.

import { headers } from "next/headers";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import type { SiteHeaderProps } from "./SiteHeader";

export async function getSiteHeaderProps(): Promise<SiteHeaderProps> {
  const incoming = await headers();

  // Platform vs tenant — the middleware sets x-resolved-tenant-id to
  // "platform" on the platform domain and a UUID on any tenant subdomain.
  // Missing header (rare, e.g. local dev hitting an unmiddlewared path)
  // is treated as platform — safer for the marketing chrome since the
  // tenant variant currently has no extra surface.
  const resolved = incoming.get(RESOLVED_TENANT_ID_HEADER);
  const isPlatformDomain = !resolved || resolved === "platform";

  // Auth — forward cookies onto a synthetic Request so we can reuse the
  // SSR client helper. `getUser` returns `data.user === null` cleanly
  // when there's no session; we let `createRequestScopedClient`'s
  // env-misconfig throw propagate (matches resolve-post-login.ts and
  // assert-platform-admin.ts).
  const forwarded = new Headers();
  const cookie = incoming.get("cookie");
  if (cookie) forwarded.set("cookie", cookie);
  const supabase = createRequestScopedClient(
    new Request("https://placeholder.internal/", { headers: forwarded }),
  );
  const { data, error } = await supabase.auth.getUser();
  // Supabase populates `error` with "Auth session missing!" for normal
  // anonymous visitors — NOT a server failure. The earlier "throw on
  // any error" version 500'd the landing page for every unauthenticated
  // visit (found on local dev smoke test). Match the resolve-post-login
  // pattern: any error or absent user → treat as anonymous. Genuine
  // env-misconfig still throws upstream in createRequestScopedClient.
  const isAuthenticated = !error && data?.user != null;

  return { isPlatformDomain, isAuthenticated };
}
