// Indexing policy (D-368) pinned as tests, because every failure mode here is
// silent: a sitemap that advertises a token URL, or a tenant subdomain that
// starts serving "index me", produces no error — just wrong pages in the
// index, discovered weeks later.

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { GET as robotsGet } from "@/app/robots.txt/route";
import { GET as sitemapGet } from "@/app/sitemap.xml/route";
import { GET as llmsGet } from "@/app/llms.txt/route";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import {
  AI_CRAWLER_USER_AGENTS,
  DISALLOWED_PATHS,
  SITEMAP_ENTRIES,
} from "@/lib/seo/site";

const PLATFORM = "ai-travelconcierge.com";
const original = process.env.PLATFORM_PRIMARY_DOMAIN;

beforeEach(() => {
  process.env.PLATFORM_PRIMARY_DOMAIN = PLATFORM;
});

afterEach(() => {
  if (original === undefined) delete process.env.PLATFORM_PRIMARY_DOMAIN;
  else process.env.PLATFORM_PRIMARY_DOMAIN = original;
});

function req(host: string): Request {
  return new Request(`https://${host}/robots.txt`, { headers: { host } });
}

describe("robots.txt", () => {
  it("serves the crawl policy and sitemap pointer on the platform domain", async () => {
    const body = await (await robotsGet(req(PLATFORM))).text();

    expect(body).toContain(`Sitemap: https://${PLATFORM}/sitemap.xml`);
    expect(body).toContain("User-agent: *");
    for (const path of DISALLOWED_PATHS) {
      expect(body).toContain(`Disallow: ${path}`);
    }
  });

  it("grants AI answer engines their own explicit user-agent groups", async () => {
    const body = await (await robotsGet(req(PLATFORM))).text();

    for (const ua of AI_CRAWLER_USER_AGENTS) {
      expect(body).toContain(`User-agent: ${ua}`);
    }
  });

  it("holds AI crawlers to the same path restrictions as everyone else", async () => {
    const body = await (await robotsGet(req(PLATFORM))).text();

    // Allowing AI crawlers means the public marketing pages, NOT /admin/,
    // /crm/, or the single-use token routes. The failure this catches is a
    // well-meaning "make the grant unambiguous" edit that replaces these
    // groups' Disallow lists with an empty one — which would hand every
    // capability URL on the site to a dozen bots at once.
    const groups = body.split(/\n(?=User-agent: )/).filter((g) =>
      AI_CRAWLER_USER_AGENTS.some((ua) => g.startsWith(`User-agent: ${ua}\n`)),
    );

    expect(groups).toHaveLength(AI_CRAWLER_USER_AGENTS.length);
    for (const group of groups) {
      for (const path of DISALLOWED_PATHS) {
        expect(group).toContain(`Disallow: ${path}`);
      }
    }
  });

  it("never emits a bare Allow directive", async () => {
    const body = await (await robotsGet(req(PLATFORM))).text();

    // `Allow: /` ahead of the Disallow list would hand token routes to any
    // first-match-wins parser. Absence of a rule already means allowed.
    expect(body).not.toMatch(/^Allow: \/$/m);
  });

  it("blanket-disallows tenant subdomains and custom domains", async () => {
    for (const host of [
      `harborlight.${PLATFORM}`,
      "harborlighttravel.com",
      "atc-main-abc123.vercel.app",
    ]) {
      const body = await (await robotsGet(req(host))).text();
      expect(body).toBe("User-agent: *\nDisallow: /\n");
    }
  });
});

describe("sitemap.xml", () => {
  it("lists every public page and every agent profile", async () => {
    const res = await sitemapGet(req(PLATFORM));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    for (const entry of SITEMAP_ENTRIES) {
      expect(body).toContain(`<loc>https://${PLATFORM}${entry.path}</loc>`);
    }
    for (const agent of AGENT_CATALOG) {
      expect(body).toContain(
        `<loc>https://${PLATFORM}/agents/${agent.slug}</loc>`,
      );
    }
  });

  it("never advertises a URL that robots.txt disallows", async () => {
    const body = await (await sitemapGet(req(PLATFORM))).text();

    // The contradiction this guards against is a real one: submitting a
    // blocked URL makes Search Console report the sitemap as errored, and
    // for the token routes it would publish capability URLs outright.
    const locs = [...body.matchAll(/<loc>[^<]*?(\/[^<]*)<\/loc>/g)].flatMap(
      (m) => m[1] ?? [],
    );
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      for (const blocked of DISALLOWED_PATHS) {
        expect(loc.startsWith(blocked)).toBe(false);
      }
    }
  });

  it("404s on any host that is not the platform domain", async () => {
    for (const host of [`harborlight.${PLATFORM}`, "harborlighttravel.com"]) {
      expect((await sitemapGet(req(host))).status).toBe(404);
    }
  });

  it("omits /for-agencies, which permanently redirects to /", async () => {
    const body = await (await sitemapGet(req(PLATFORM))).text();

    // Listing a redirecting URL makes Search Console report the sitemap as
    // errored, and splits the signal the 308 exists to consolidate.
    expect(body).not.toContain("/for-agencies");
    expect(body).toContain(`<loc>https://${PLATFORM}/</loc>`);
  });
});

describe("llms.txt", () => {
  it("states the facts an assistant most often gets wrong", async () => {
    const body = await (await llmsGet(req(PLATFORM))).text();

    // These three negations are the whole point of the file — without them
    // summarizers routinely describe this as a consumer booking site or a
    // competing host agency.
    expect(body).toContain("not** a host agency");
    expect(body).toContain("not** a consumer");
    expect(body).toContain("does not take a cut of any commission");
  });

  it("404s on any host that is not the platform domain", async () => {
    expect((await llmsGet(req(`harborlight.${PLATFORM}`))).status).toBe(404);
  });
});
