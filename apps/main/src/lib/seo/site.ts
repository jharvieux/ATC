// Single source of truth for what search engines and answer engines are
// allowed to see. Both /robots.txt and /sitemap.xml read from here, so the
// sitemap can never advertise a URL that robots.txt disallows.
//
// Indexing policy (D-368): only the platform primary domain is indexable.
// Tenant subdomains and Agency-tier custom domains serve the same app shell
// with agency branding — indexing them would compete with the platform
// domain for the same queries and split link equity across hundreds of
// near-duplicate hosts.

/** Canonical origin for every indexable URL. */
export function siteOrigin(): string {
  const domain = process.env.PLATFORM_PRIMARY_DOMAIN;
  return domain ? `https://${domain}` : "http://localhost:3000";
}

/**
 * True when this request arrived on the platform primary domain — the only
 * host we let crawlers index. Host header carries a port in local dev.
 */
export function isIndexableHost(host: string | null): boolean {
  const primary = process.env.PLATFORM_PRIMARY_DOMAIN;
  if (!primary) return false;
  return host?.replace(/:\d+$/, "") === primary;
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
 * AI crawlers allowed explicitly rather than by omission. Naming them is
 * what makes the allowance durable: several of these operators treat an
 * absent user-agent group as "follow the wildcard", and the wildcard group
 * here carries a long Disallow list. An explicit empty Disallow for each
 * bot is an unambiguous grant.
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

/** Per-agent profile pages, appended to SITEMAP_ENTRIES at request time. */
export function agentSitemapEntries(slugs: readonly string[]): SitemapEntry[] {
  return slugs.map((slug) => ({
    path: `/agents/${slug}`,
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));
}
