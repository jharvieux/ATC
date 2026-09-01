// Host-aware robots.txt. The app answers on the platform primary domain,
// on every tenant subdomain, and on Agency-tier custom domains — a static
// public/robots.txt would hand the same "index me" policy to all of them.
//
// The platform domain and an opted-in verified custom domain get a real crawl
// policy. Every platform subdomain and disabled custom domain gets a blanket
// Disallow (D-368 + #2058).

import {
  AI_CRAWLER_USER_AGENTS,
  DISALLOWED_PATHS,
} from "@/lib/seo/site";
import { resolveIndexingTarget } from "@/lib/seo/resolve-indexing-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function textResponse(body: string, cacheControl: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": cacheControl,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const target = await resolveIndexingTarget(request.headers.get("host"));
  if (!target) {
    return textResponse("User-agent: *\nDisallow: /\n", "private, no-store");
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
      `Sitemap: ${target.origin}/sitemap.xml\n`,
    target.kind === "platform"
      ? "public, max-age=3600, s-maxage=86400"
      : "private, no-store",
  );
}
