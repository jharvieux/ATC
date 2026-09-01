// Single source of truth for what search engines and answer engines are
// allowed to see. Both /robots.txt and /sitemap.xml read from here, so the
// sitemap can never advertise a URL that robots.txt disallows.
//
// Indexing policy (D-368 + #2058): the platform primary domain is indexable;
// a verified Agency custom domain may opt in. Platform tenant subdomains can
// never opt in because indexing near-duplicates would split link equity.

// Both helpers below read process.env directly rather than through env().
// Not an oversight, and not worth "cleaning up": env() memoizes the parsed
// schema into a module-level singleton on first call, so once any test in a
// file has touched it, later mutations of process.env.PLATFORM_PRIMARY_DOMAIN
// are ignored. The host-awareness tests work by swapping that value between
// cases — under env() they would keep passing while silently asserting
// against one frozen domain, which is the failure mode these tests exist to
// catch. The value is a plain hostname with no parsing or defaulting to gain
// from the schema.

/** Canonical origin for every indexable URL. */
export function siteOrigin(): string {
  const domain = process.env.PLATFORM_PRIMARY_DOMAIN;
  return domain ? `https://${domain}` : "http://localhost:3000";
}

export function normalizeHost(host: string | null): string | null {
  return host?.replace(/:\d+$/, "").toLowerCase() ?? null;
}

/**
 * True when this request arrived on the platform primary domain — the only
 * host we let crawlers index. Host header carries a port in local dev.
 */
export function isIndexableHost(host: string | null): boolean {
  const primary = process.env.PLATFORM_PRIMARY_DOMAIN?.toLowerCase();
  if (!primary) return false;
  return normalizeHost(host) === primary;
}

/**
 * Path prefixes crawlers must never fetch. Two distinct reasons, both
 * load-bearing:
 *   - token surfaces (/i/, /q/, /companion/, /group/) are capability URLs —
 *     the token IS the credential, so a crawler that fetches one burns a
 *     single-use link and lands private itinerary content in a search index.
 *   - app surfaces (/crm/, /admin/, /settings/) are login-gated; crawling
 *     them yields nothing but login redirects and wasted crawl budget.
 *
 * Deliberately NOT here: /signup and /chat. Both are linked from the site
 * header on every page, so crawlers will certainly discover them. Blocking a
 * discoverable URL in robots.txt doesn't de-index it — it produces the
 * URL-only listing with "no information is available for this page", because
 * the crawler is forbidden from fetching the page to read its noindex. Those
 * two carry `robots: { index: false, follow: true }` in their page metadata
 * instead, which drops them from the index cleanly.
 */
export const DISALLOWED_PATHS = [
  "/api/",
  "/admin/",
  "/supervisor",
  "/crm/",
  "/settings/",
  "/tenant-admin/",
  "/onboarding/",
  "/concierge",
  "/auth/",
  "/consent",
  "/booking/",
  "/groups/",
  "/group/",
  "/companion/",
  "/email/",
  "/i/",
  "/q/",
] as const;

/** Metadata for pages that must be crawlable but never indexed. */
export const NOINDEX_FOLLOW = {
  index: false,
  follow: true,
} as const;

/**
 * AI crawlers named explicitly rather than left to the wildcard group.
 *
 * Each of these gets its own group carrying the SAME DISALLOWED_PATHS as the
 * wildcard — not an empty Disallow. The grant is "you may crawl the public
 * marketing pages", not "you may crawl anything": an AI crawler has no more
 * business fetching /admin/, /crm/, or a single-use /i/<token> invite URL
 * than a search crawler does.
 *
 * So why name them at all, if the wildcard already permits the same thing?
 * Because an absent group is an ambiguous signal. Google-Extended and
 * Applebot-Extended in particular are opt-OUT mechanisms where silence means
 * consent, and reading consent off silence is not something the operator
 * should have to infer from this file later. Listing them makes the decision
 * explicit and auditable.
 */
export const AI_CRAWLER_USER_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "meta-externalagent",
  "Bingbot",
  "DuckAssistBot",
  "cohere-ai",
] as const;

export interface SitemapEntry {
  path: string;
  changeFrequency: "daily" | "weekly" | "monthly" | "yearly";
  priority: number;
}

/**
 * Every indexable URL on the platform domain, most important first.
 *
 * Deliberately excluded: /chat/* (redirects to the booking tenant on the
 * platform domain, so it has no canonical apex URL), /signup and /auth/*
 * (funnel entry points with no standalone content), and every token route.
 */
export const SITEMAP_ENTRIES: readonly SitemapEntry[] = [
  // "/" is the agency landing page. /for-agencies is deliberately absent —
  // it 308s here, and listing a redirecting URL makes Search Console flag
  // the sitemap.
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/travelers", changeFrequency: "weekly", priority: 0.8 },
  { path: "/agents/quiz", changeFrequency: "monthly", priority: 0.7 },
  { path: "/legal/ai-disclaimer", changeFrequency: "yearly", priority: 0.3 },
  { path: "/legal/sub-processors", changeFrequency: "yearly", priority: 0.3 },
];

/** Public tenant-host URLs. /travelers is platform-only and 404s here. */
export const TENANT_SITEMAP_ENTRIES: readonly SitemapEntry[] =
  SITEMAP_ENTRIES.filter((entry) => entry.path !== "/travelers");

/** Per-agent profile pages, appended to SITEMAP_ENTRIES at request time. */
export function agentSitemapEntries(slugs: readonly string[]): SitemapEntry[] {
  return slugs.map((slug) => ({
    path: `/agents/${slug}`,
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));
}
