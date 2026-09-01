// Host-aware sitemap. The platform domain and an opted-in verified custom
// domain publish only URLs at their own origin; tenant subdomains, disabled
// custom domains, and previews 404. A sitemap served from host A listing host
// B's URLs is cross-submission, which search engines reject unless both hosts
// are verified together (D-368 + #2058).
//
// No <lastmod>: these pages are code, not content, so the only honest value
// would be the deploy timestamp, which would tell crawlers every page changed
// on every deploy. Google discounts a sitemap whose lastmod it learns not to
// trust, so omitting it is strictly better than stamping "now".

import { AGENT_CATALOG } from "@/lib/agents/catalog";
import {
  agentSitemapEntries,
  SITEMAP_ENTRIES,
  TENANT_SITEMAP_ENTRIES,
} from "@/lib/seo/site";
import { resolveIndexingTarget } from "@/lib/seo/resolve-indexing-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const target = await resolveIndexingTarget(request.headers.get("host"));
  if (!target) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  }

  const origin = target.origin;
  const entries = [
    ...(target.kind === "platform" ? SITEMAP_ENTRIES : TENANT_SITEMAP_ENTRIES),
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
      "Cache-Control":
        target.kind === "platform"
          ? "public, max-age=3600, s-maxage=86400"
          : "private, no-store",
    },
  });
}
