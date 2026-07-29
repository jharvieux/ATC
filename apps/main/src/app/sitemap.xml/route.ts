// Host-aware sitemap. Only the platform primary domain has indexable URLs
// (D-368), so every other host — tenant subdomain, custom domain, preview
// deployment — 404s rather than advertising apex URLs it has no authority
// over. A sitemap served from host A listing host B's URLs is cross-submission,
// which search engines reject unless both hosts are verified together.
//
// No <lastmod>: these pages are code, not content, so the only honest value
// would be the deploy timestamp, which would tell crawlers every page changed
// on every deploy. Google discounts a sitemap whose lastmod it learns not to
// trust, so omitting it is strictly better than stamping "now".

import { AGENT_CATALOG } from "@/lib/agents/catalog";
import {
  agentSitemapEntries,
  isIndexableHost,
  siteOrigin,
  SITEMAP_ENTRIES,
} from "@/lib/seo/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!isIndexableHost(request.headers.get("host"))) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const origin = siteOrigin();
  const entries = [
    ...SITEMAP_ENTRIES,
    ...agentSitemapEntries(AGENT_CATALOG.map((a) => a.slug)),
  ];

  const urls = entries
    .map(
      (e) =>
        `  <url>\n` +
        `    <loc>${origin}${e.path}</loc>\n` +
        `    <changefreq>${e.changeFrequency}</changefreq>\n` +
        `    <priority>${e.priority.toFixed(1)}</priority>\n` +
        `  </url>`,
    )
    .join("\n");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urls}\n` +
    `</urlset>\n`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
