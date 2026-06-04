// Helper to compute the SiteHeader props from the request that called a
// server component or layout. Keeps the auth-check + domain-check
// boilerplate in one place rather than duplicated across every page that
// renders the header.

import { headers } from "next/headers";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import type { SiteHeaderProps } from "./SiteHeader";

const RESOLVED_TENANT_ID_HEADER = "x-resolved-tenant-id";

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
  // Surface unexpected auth errors loudly rather than silently rendering
  // the Login button to a possibly-authenticated user. Matches the
  // destructuring pattern in resolve-post-login.ts and
  // assert-platform-admin.ts. "No session" is `data.user === null`, NOT
  // an error — only network/JWT-verification failures populate `error`.
  if (error) throw new Error(`getSiteHeaderProps: getUser failed: ${error.message}`);
  const isAuthenticated = data?.user != null;

  return { isPlatformDomain, isAuthenticated };
}
