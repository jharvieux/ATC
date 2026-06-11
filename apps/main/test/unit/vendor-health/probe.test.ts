// §26.9 / #785 / #786 — vendor-health-probe: vendor coverage + alert-once semantics.
//
// Covers:
//   1. pingInngest() — success on indicator="none", failure otherwise.
//   2. pingRagReadiness() — correct vendor routing per JSON body.
//   3. Alert-once semantics — sendOperatorAlert fires on transition only,
//      correct severity per status, silent on repeat failures.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: () => Promise<unknown>) => handler,
  },
}));

const mockUpsertVendorHealth = vi.fn().mockResolvedValue({ prior_status: "healthy", new_status: "healthy", transitioned: false });
vi.mock("@/lib/vendor-health/registry", () => ({
  upsertVendorHealth: (...args: unknown[]) => mockUpsertVendorHealth(...args),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

const mockSendOperatorAlert = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: (...args: unknown[]) => mockSendOperatorAlert(...args),
}));

// Pluggable fetch mock: tests set fetchResponses to control what each URL returns.
type FetchResponse = { ok: boolean; status: number; json?: () => Promise<unknown> };
const fetchResponses = new Map<string, FetchResponse>();

vi.stubGlobal("fetch", async (url: string) => {
  const res = fetchResponses.get(url);
  if (!res) throw new Error(`unhandled fetch: ${url}`);
  return {
    ok: res.ok,
    status: res.status,
    json: res.json ?? (() => Promise.resolve({})),
  };
});

import { vendorHealthProbe } from "@/inngest/vendor-health-probe";
const run = vendorHealthProbe as unknown as () => Promise<unknown>;

beforeEach(() => {
  fetchResponses.clear();
  mockUpsertVendorHealth.mockClear();
  mockUpsertVendorHealth.mockResolvedValue({ prior_status: "healthy", new_status: "healthy", transitioned: false });
  mockSendOperatorAlert.mockClear();
  delete process.env.STAGING_MODE;
  delete process.env.RAG_SERVICE_URL;
  // Stub existing vendors so they don't throw on undefined URLs.
  fetchResponses.set("undefined/auth/v1/health", { ok: true, status: 200 });
  // openai, stripe, resend return 401 (up, unauthorized)
  fetchResponses.set("https://api.openai.com/v1/models", { ok: false, status: 401 });
  fetchResponses.set("https://api.stripe.com/v1/balance", { ok: false, status: 401 });
  fetchResponses.set("https://api.resend.com/domains", { ok: false, status: 401 });
});

describe("pingInngest — statuspage indicator parsing", () => {
  it("records success when indicator=none (all systems operational)", async () => {
    fetchResponses.set("https://status.inngest.com/api/v2/status.json", {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ status: { indicator: "none", description: "All Systems Operational" } }),
    });
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", {
      ok: true, status: 200,
      json: () => Promise.resolve({ redis: "ok", supabase_rag: "ok" }),
    });
    await run();
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(expect.objectContaining({ vendor: "inngest", success: true }));
    expect(mockUpsertVendorHealth).not.toHaveBeenCalledWith(expect.objectContaining({ vendor: "inngest", success: false }));
  });

  it("records failure when indicator=major", async () => {
    fetchResponses.set("https://status.inngest.com/api/v2/status.json", {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ status: { indicator: "major", description: "Major Service Outage" } }),
    });
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", {
      ok: true, status: 200,
      json: () => Promise.resolve({ redis: "ok", supabase_rag: "ok" }),
    });
    await run();
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "inngest", success: false, error_message: "status_major" }),
    );
  });

  it("records failure when statuspage itself is unreachable", async () => {
    fetchResponses.set("https://status.inngest.com/api/v2/status.json", { ok: false, status: 503 });
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", {
      ok: true, status: 200,
      json: () => Promise.resolve({ redis: "ok", supabase_rag: "ok" }),
    });
    await run();
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "inngest", success: false, error_message: "http_503" }),
    );
  });
});

describe("pingRagReadiness — upstash + rag + supabase_rag routing", () => {
  beforeEach(() => {
    fetchResponses.set("https://status.inngest.com/api/v2/status.json", {
      ok: true, status: 200,
      json: () => Promise.resolve({ status: { indicator: "none" } }),
    });
  });

  it("all ok: records success for rag, upstash, supabase_rag", async () => {
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", {
      ok: true, status: 200,
      json: () => Promise.resolve({ redis: "ok", supabase_rag: "ok" }),
    });
    await run();
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(expect.objectContaining({ vendor: "rag", success: true }));
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(expect.objectContaining({ vendor: "upstash", success: true }));
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(expect.objectContaining({ vendor: "supabase_rag", success: true }));
  });

  it("redis down: rag failure (503), upstash failure, supabase_rag ok", async () => {
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", {
      ok: false, status: 503,
      json: () => Promise.resolve({ redis: "down", supabase_rag: "ok" }),
    });
    await run();
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "rag", success: false, error_message: "http_503" }),
    );
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "upstash", success: false, error_message: "down" }),
    );
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(expect.objectContaining({ vendor: "supabase_rag", success: true }));
  });

  it("RAG endpoint unreachable: all three vendors record failure", async () => {
    process.env.RAG_SERVICE_URL = "https://rag.test";
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "https://rag.test/api/health/ready") throw new Error("ECONNREFUSED");
      const res = fetchResponses.get(url);
      if (!res) throw new Error(`unhandled fetch: ${url}`);
      return { ok: res.ok, status: res.status, json: res.json ?? (() => Promise.resolve({})) };
    });
    await run();
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "rag", success: false, error_message: expect.stringContaining("ECONNREFUSED") }),
    );
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "upstash", success: false, error_message: expect.stringContaining("ECONNREFUSED") }),
    );
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "supabase_rag", success: false, error_message: expect.stringContaining("ECONNREFUSED") }),
    );
  });

  it("RAG_SERVICE_URL not set: all three vendors record failure", async () => {
    delete process.env.RAG_SERVICE_URL;
    await run();
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "rag", success: false, error_message: "RAG_SERVICE_URL not configured" }),
    );
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "upstash", success: false, error_message: "RAG_SERVICE_URL not configured" }),
    );
    expect(mockUpsertVendorHealth).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "supabase_rag", success: false, error_message: "RAG_SERVICE_URL not configured" }),
    );
  });
});

describe("alert-once semantics — sendOperatorAlert fires on transition only", () => {
  beforeEach(() => {
    // Stub all vendor URLs so pings don't throw.
    fetchResponses.set("https://status.inngest.com/api/v2/status.json", {
      ok: true, status: 200,
      json: () => Promise.resolve({ status: { indicator: "none" } }),
    });
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", {
      ok: true, status: 200,
      json: () => Promise.resolve({ redis: "ok", supabase_rag: "ok" }),
    });
  });

  it("fires high-severity alert when vendor transitions to down", async () => {
    mockUpsertVendorHealth.mockImplementation(({ vendor }: { vendor: string }) => {
      if (vendor === "stripe") {
        return Promise.resolve({ prior_status: "degraded", new_status: "down", transitioned: true });
      }
      return Promise.resolve({ prior_status: "healthy", new_status: "healthy", transitioned: false });
    });
    await run();
    expect(mockSendOperatorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "high", signal: "vendor_down" }),
    );
    expect(mockSendOperatorAlert).toHaveBeenCalledTimes(1);
  });

  it("fires medium-severity alert when vendor transitions to degraded", async () => {
    mockUpsertVendorHealth.mockImplementation(({ vendor }: { vendor: string }) => {
      if (vendor === "openai") {
        return Promise.resolve({ prior_status: "healthy", new_status: "degraded", transitioned: true });
      }
      return Promise.resolve({ prior_status: "healthy", new_status: "healthy", transitioned: false });
    });
    await run();
    expect(mockSendOperatorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "medium", signal: "vendor_degraded" }),
    );
    expect(mockSendOperatorAlert).toHaveBeenCalledTimes(1);
  });

  it("fires low-severity alert when vendor recovers to healthy", async () => {
    mockUpsertVendorHealth.mockImplementation(({ vendor }: { vendor: string }) => {
      if (vendor === "resend") {
        return Promise.resolve({ prior_status: "down", new_status: "healthy", transitioned: true });
      }
      return Promise.resolve({ prior_status: "healthy", new_status: "healthy", transitioned: false });
    });
    await run();
    expect(mockSendOperatorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "low", signal: "vendor_recovered" }),
    );
    expect(mockSendOperatorAlert).toHaveBeenCalledTimes(1);
  });

  it("does not fire alert when transitioned=false (same status repeated)", async () => {
    // All vendors stay in their current state — no transitions.
    mockUpsertVendorHealth.mockResolvedValue({ prior_status: "down", new_status: "down", transitioned: false });
    await run();
    expect(mockSendOperatorAlert).not.toHaveBeenCalled();
  });

  it("does not fire alert when upsert throws (fail-closed — no spurious alerts)", async () => {
    mockUpsertVendorHealth.mockRejectedValue(new Error("[vendor-health] upsert failed: connection refused"));
    await run();
    // Promise.allSettled absorbs the rejection; no alert should fire.
    expect(mockSendOperatorAlert).not.toHaveBeenCalled();
  });
});
