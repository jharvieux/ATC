// Indexing policy (D-368) pinned as tests, because every failure mode here is
// silent: a sitemap that advertises a token URL, or a tenant subdomain that
// starts serving "index me", produces no error — just wrong pages in the
// index, discovered weeks later.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentIndexingTenantByCustomDomain: vi.fn(),
}));

vi.mock("@/lib/tenancy/resolve-tenant", () => ({
  getCurrentIndexingTenantByCustomDomain:
    mocks.getCurrentIndexingTenantByCustomDomain,
}));

import { GET as robotsGet } from "@/app/robots.txt/route";
import { GET as sitemapGet } from "@/app/sitemap.xml/route";
import { GET as llmsGet } from "@/app/llms.txt/route";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import {
  AI_CRAWLER_USER_AGENTS,
  DISALLOWED_PATHS,
  SITEMAP_ENTRIES,
  TENANT_SITEMAP_ENTRIES,
} from "@/lib/seo/site";

const PLATFORM = "ai-travelconcierge.com";
const original = process.env.PLATFORM_PRIMARY_DOMAIN;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLATFORM_PRIMARY_DOMAIN = PLATFORM;
});

afterEach(() => {
  if (original === undefined) delete process.env.PLATFORM_PRIMARY_DOMAIN;
  else process.env.PLATFORM_PRIMARY_DOMAIN = original;
});

function req(host: string): Request {
  return new Request(`https://${host}/robots.txt`, { headers: { host } });
}

function customDomainTenant(
  enabled: boolean,
  tierCode = "sub_agency",
) {
  return {
    id: "tenant-1",
    status: "active",
    custom_domain: "harborlighttravel.com",
    custom_domain_status: "verified",
    search_indexing_enabled: enabled,
    tier_code: tierCode,
  };
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

  it("blanket-disallows a disabled custom domain", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue(
      customDomainTenant(false),
    );

    const body = await (
      await robotsGet(req("harborlighttravel.com"))
    ).text();

    expect(body).toBe("User-agent: *\nDisallow: /\n");
  });

  it("serves the full crawl policy at an enabled custom-domain origin", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue(
      customDomainTenant(true),
    );

    const body = await (
      await robotsGet(req("harborlighttravel.com"))
    ).text();

    expect(body).toContain(
      "Sitemap: https://harborlighttravel.com/sitemap.xml",
    );
    for (const path of DISALLOWED_PATHS) {
      expect(body).toContain(`Disallow: ${path}`);
    }
  });

  it("blanket-disallows a platform subdomain regardless of tenant opt-in", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue(
      customDomainTenant(true),
    );

    const body = await (
      await robotsGet(req(`harborlight.${PLATFORM}`))
    ).text();

    expect(body).toBe("User-agent: *\nDisallow: /\n");
    expect(
      mocks.getCurrentIndexingTenantByCustomDomain,
    ).not.toHaveBeenCalled();
  });

  it("blanket-disallows a downgraded custom domain", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue(
      customDomainTenant(true, "sub_pro"),
    );

    const body = await (
      await robotsGet(req("harborlighttravel.com"))
    ).text();

    expect(body).toBe("User-agent: *\nDisallow: /\n");
  });

  it("blanket-disallows when the current tier is missing", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue({
      ...customDomainTenant(true),
      tier_code: null,
    });

    const body = await (
      await robotsGet(req("harborlighttravel.com"))
    ).text();

    expect(body).toBe("User-agent: *\nDisallow: /\n");
  });

  it("observes an indexing disable on the next crawler read", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain
      .mockResolvedValueOnce(customDomainTenant(true))
      .mockResolvedValueOnce(customDomainTenant(false));

    const enabled = await (
      await robotsGet(req("harborlighttravel.com"))
    ).text();
    const disabled = await (
      await robotsGet(req("harborlighttravel.com"))
    ).text();

    expect(enabled).toContain(
      "Sitemap: https://harborlighttravel.com/sitemap.xml",
    );
    expect(disabled).toBe("User-agent: *\nDisallow: /\n");
    expect(
      mocks.getCurrentIndexingTenantByCustomDomain,
    ).toHaveBeenCalledTimes(2);
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

  it("404s on a disabled custom domain", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue(
      customDomainTenant(false),
    );

    expect((await sitemapGet(req("harborlighttravel.com"))).status).toBe(404);
  });

  it("lists only tenant-public URLs at the enabled custom-domain origin", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue(
      customDomainTenant(true),
    );

    const res = await sitemapGet(req("harborlighttravel.com"));
    const body = await res.text();

    expect(res.status).toBe(200);
    for (const entry of TENANT_SITEMAP_ENTRIES) {
      expect(body).toContain(
        `<loc>https://harborlighttravel.com${entry.path}</loc>`,
      );
    }
    expect(body).not.toContain(`https://${PLATFORM}`);
    expect(body).not.toContain("/travelers");
  });

  it("404s on a platform subdomain regardless of tenant opt-in", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue(
      customDomainTenant(true),
    );

    expect((await sitemapGet(req(`harborlight.${PLATFORM}`))).status).toBe(404);
    expect(
      mocks.getCurrentIndexingTenantByCustomDomain,
    ).not.toHaveBeenCalled();
  });

  it("404s on a downgraded custom domain", async () => {
    mocks.getCurrentIndexingTenantByCustomDomain.mockResolvedValue(
      customDomainTenant(true, "byo_professional"),
    );

    expect((await sitemapGet(req("harborlighttravel.com"))).status).toBe(404);
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
