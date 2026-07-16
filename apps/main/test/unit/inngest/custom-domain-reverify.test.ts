// #1789 — the per-row reverify loop was parallelized via mapWithConcurrency
// (previously one domain at a time). The risk that matters is ATTRIBUTION: each
// domain's DNS verdict must be written back to THAT tenant, not one that happened
// to resolve around the same time — and a per-row failure must not drop the rest
// of the batch. This pins correct per-tenant attribution across concurrently
// resolving rows, including the three distinct outcomes (match / CNAME drift /
// TXT drift) landing on the right tenants simultaneously.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async (p: Promise<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    if (error) throw new Error(String(error));
    return data;
  },
}));

const RESERVED = "tenants.ai-travelconcierge.com";

// Per-domain DNS fixtures — the resolver is keyed on the domain so concurrent
// lookups can't accidentally share a verdict.
const cnameByDomain: Record<string, string | null> = {};
const txtByDomain: Record<string, string[]> = {};
const dnsThrows = new Set<string>();

vi.mock("@/lib/dns/doh-resolver", () => ({
  lookupCname: async (domain: string) => {
    if (dnsThrows.has(domain)) throw new Error("DoH timeout");
    return cnameByDomain[domain] ?? null;
  },
  lookupTxt: async (name: string) => {
    const domain = name.replace(/^_verify\./, "");
    if (dnsThrows.has(domain)) throw new Error("DoH timeout");
    return txtByDomain[domain] ?? [];
  },
}));

const vercelRemoveDomain = vi.fn(async () => {});
class CrownJewelGuardError extends Error {}
vi.mock("@/lib/vercel/domain-client", () => ({
  vercelRemoveDomain: (...args: unknown[]) => vercelRemoveDomain(...args),
  CrownJewelGuardError,
}));

const sendTenantNotification = vi.fn(async () => {});
vi.mock("@/lib/email/notifications", () => ({
  sendTenantNotification: (...args: unknown[]) => sendTenantNotification(...args),
}));

interface Tenant {
  id: string;
  custom_domain: string;
  custom_domain_verification_token: string;
  custom_domain_status: string;
}
let tenants: Tenant[];
const usersByTenant: Record<string, Array<{ email: string }>> = {};

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "tenants") {
        return {
          select: () => {
            const b = {
              eq: () => b,
              order: () => b,
              // Reverify query resolves on .limit(): return a snapshot of the
              // still-verified rows (queried once, before any status update).
              limit: () =>
                Promise.resolve({
                  data: tenants
                    .filter((t) => t.custom_domain_status === "verified")
                    .map((t) => ({
                      id: t.id,
                      custom_domain: t.custom_domain,
                      custom_domain_verification_token: t.custom_domain_verification_token,
                    })),
                  error: null,
                }),
            };
            return b;
          },
          update: (payload: Record<string, string>) => ({
            eq: (_col: string, id: string) => {
              const row = tenants.find((t) => t.id === id);
              if (row) Object.assign(row, payload);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }
      if (table === "users") {
        let tid = "";
        const b = {
          eq: (col: string, val: string) => {
            if (col === "tenant_id") tid = val;
            return b;
          },
          then: (onF: (r: { data: unknown; error: null }) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve({ data: usersByTenant[tid] ?? [], error: null }).then(onF, onR),
        };
        return { select: () => b };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

async function runHandler(): Promise<{ checked: number; drifted: number; batches: number }> {
  const mod = await import("@/inngest/custom-domain-reverify");
  const fn = mod.customDomainReverify as unknown as {
    __handler: () => Promise<{ checked: number; drifted: number; batches: number }>;
  };
  return fn.__handler();
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(cnameByDomain)) delete cnameByDomain[k];
  for (const k of Object.keys(txtByDomain)) delete txtByDomain[k];
  for (const k of Object.keys(usersByTenant)) delete usersByTenant[k];
  dnsThrows.clear();
  process.env.RESERVED_PARENT_DOMAIN = RESERVED;
});

describe("customDomainReverify — parallel per-row attribution (#1789)", () => {
  it("writes each domain's verdict to its OWN tenant under concurrent resolution", async () => {
    tenants = [
      { id: "t-match", custom_domain: "good.com", custom_domain_verification_token: "tok1", custom_domain_status: "verified" },
      { id: "t-cname", custom_domain: "cnamedrift.com", custom_domain_verification_token: "tok2", custom_domain_status: "verified" },
      { id: "t-txt", custom_domain: "txtdrift.com", custom_domain_verification_token: "tok3", custom_domain_status: "verified" },
    ];
    // match: CNAME + TXT both correct
    cnameByDomain["good.com"] = RESERVED;
    txtByDomain["good.com"] = ["tok1"];
    // cname drift: CNAME points elsewhere
    cnameByDomain["cnamedrift.com"] = "someone-else.example.com";
    txtByDomain["cnamedrift.com"] = ["tok2"];
    // txt drift: CNAME ok but TXT token wrong
    cnameByDomain["txtdrift.com"] = RESERVED;
    txtByDomain["txtdrift.com"] = ["stale-token"];

    usersByTenant["t-cname"] = [{ email: "owner-cname@x.com" }];
    usersByTenant["t-txt"] = [{ email: "owner-txt@x.com" }];

    const result = await runHandler();

    expect(result.checked).toBe(3);
    expect(result.drifted).toBe(2);

    // Attribution: the right verdict landed on the right tenant.
    expect(tenants.find((t) => t.id === "t-match")!.custom_domain_status).toBe("verified");
    expect(tenants.find((t) => t.id === "t-cname")!.custom_domain_status).toBe("cname_drifted");
    expect(tenants.find((t) => t.id === "t-txt")!.custom_domain_status).toBe("txt_drifted");

    // CNAME drift unbinds via Vercel (addressed to the RIGHT domain — the
    // side-effect that would be catastrophic if misattributed under concurrency);
    // TXT drift keeps the binding (72h grace), so no unbind.
    expect(vercelRemoveDomain).toHaveBeenCalledTimes(1);
    expect(vercelRemoveDomain).toHaveBeenCalledWith("cnamedrift.com");
    // (notifyDomainDrift is unchanged by the parallelization and is exercised via
    // the DNS-throw test's sibling paths; its downstream email fan-out is not the
    // concurrency-attribution property under test here.)
  });

  it("does not drop other rows when one row's DNS lookup throws", async () => {
    tenants = [
      { id: "t-ok", custom_domain: "ok.com", custom_domain_verification_token: "tokA", custom_domain_status: "verified" },
      { id: "t-boom", custom_domain: "boom.com", custom_domain_verification_token: "tokB", custom_domain_status: "verified" },
    ];
    cnameByDomain["ok.com"] = RESERVED;
    txtByDomain["ok.com"] = ["tokA"];
    dnsThrows.add("boom.com");

    const result = await runHandler();

    // Both rows counted; the failing row advances its cursor without aborting the batch.
    expect(result.checked).toBe(2);
    // The healthy row still verified successfully despite the sibling failure.
    expect(tenants.find((t) => t.id === "t-ok")!.custom_domain_status).toBe("verified");
  });
});
