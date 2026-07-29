// Host-aware robots.txt. The app answers on the platform primary domain,
// on every tenant subdomain, and on Agency-tier custom domains — a static
// public/robots.txt would hand the same "index me" policy to all of them.
//
// Platform domain gets a real crawl policy; every other host gets a blanket
// Disallow so tenant surfaces stay out of the index (D-368).

import {
  AI_CRAWLER_USER_AGENTS,
  DISALLOWED_PATHS,
  isIndexableHost,
  siteOrigin,
} from "@/lib/seo/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function textResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  if (!isIndexableHost(request.headers.get("host"))) {
    return textResponse("User-agent: *\nDisallow: /\n");
  }

  // No `Allow: /` anywhere: an absent rule already means "allowed", and
  // adding one creates a precedence question. Google and Bing resolve
  // conflicts by longest match, but naive first-match-wins parsers would
  // read a leading `Allow: /` as permission to crawl the token routes.
  const disallow = DISALLOWED_PATHS.map((p) => `Disallow: ${p}`).join("\n");
  const aiCrawlers = AI_CRAWLER_USER_AGENTS.map(
    (ua) => `User-agent: ${ua}\n${disallow}\n`,
  ).join("\n");

  return textResponse(
    `User-agent: *\n${disallow}\n\n` +
      `${aiCrawlers}\n` +
      `Sitemap: ${siteOrigin()}/sitemap.xml\n`,
  );
}
