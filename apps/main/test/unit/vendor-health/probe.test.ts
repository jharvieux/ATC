// §26.9 / #785 — vendor-health-probe new vendor coverage.
//
// Tests that pingInngest() records success when status.indicator="none"
// and failure otherwise, and that pingRagReadiness() correctly routes
// each JSON field to the right vendor slot.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: () => Promise<unknown>) => handler,
  },
}));

const mockRecordSuccess = vi.fn();
const mockRecordFailure = vi.fn();
vi.mock("@/lib/vendor-health/registry", () => ({
  recordVendorSuccess: (...args: unknown[]) => mockRecordSuccess(...args),
  recordVendorFailure: (...args: unknown[]) => mockRecordFailure(...args),
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
  mockRecordSuccess.mockClear();
  mockRecordFailure.mockClear();
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
    expect(mockRecordSuccess).toHaveBeenCalledWith("inngest");
    expect(mockRecordFailure).not.toHaveBeenCalledWith("inngest", expect.anything());
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
    expect(mockRecordFailure).toHaveBeenCalledWith("inngest", "status_major");
    expect(mockRecordSuccess).not.toHaveBeenCalledWith("inngest");
  });

  it("records failure when statuspage itself is unreachable", async () => {
    fetchResponses.set("https://status.inngest.com/api/v2/status.json", { ok: false, status: 503 });
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", {
      ok: true, status: 200,
      json: () => Promise.resolve({ redis: "ok", supabase_rag: "ok" }),
    });
    await run();
    expect(mockRecordFailure).toHaveBeenCalledWith("inngest", "http_503");
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
    expect(mockRecordSuccess).toHaveBeenCalledWith("rag");
    expect(mockRecordSuccess).toHaveBeenCalledWith("upstash");
    expect(mockRecordSuccess).toHaveBeenCalledWith("supabase_rag");
  });

  it("redis down: rag failure (503), upstash failure, supabase_rag ok", async () => {
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", {
      ok: false, status: 503,
      json: () => Promise.resolve({ redis: "down", supabase_rag: "ok" }),
    });
    await run();
    expect(mockRecordFailure).toHaveBeenCalledWith("rag", "http_503");
    expect(mockRecordFailure).toHaveBeenCalledWith("upstash", "down");
    expect(mockRecordSuccess).toHaveBeenCalledWith("supabase_rag");
  });

  it("RAG endpoint unreachable: all three vendors record failure", async () => {
    process.env.RAG_SERVICE_URL = "https://rag.test";
    fetchResponses.set("https://rag.test/api/health/ready", (() => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchResponse);
    // Override fetch for this URL to throw
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "https://rag.test/api/health/ready") throw new Error("ECONNREFUSED");
      const res = fetchResponses.get(url);
      if (!res) throw new Error(`unhandled fetch: ${url}`);
      return { ok: res.ok, status: res.status, json: res.json ?? (() => Promise.resolve({})) };
    });
    await run();
    expect(mockRecordFailure).toHaveBeenCalledWith("rag", expect.stringContaining("ECONNREFUSED"));
    expect(mockRecordFailure).toHaveBeenCalledWith("upstash", expect.stringContaining("ECONNREFUSED"));
    expect(mockRecordFailure).toHaveBeenCalledWith("supabase_rag", expect.stringContaining("ECONNREFUSED"));
  });

  it("RAG_SERVICE_URL not set: all three vendors record failure", async () => {
    delete process.env.RAG_SERVICE_URL;
    await run();
    expect(mockRecordFailure).toHaveBeenCalledWith("rag", "RAG_SERVICE_URL not configured");
    expect(mockRecordFailure).toHaveBeenCalledWith("upstash", "RAG_SERVICE_URL not configured");
    expect(mockRecordFailure).toHaveBeenCalledWith("supabase_rag", "RAG_SERVICE_URL not configured");
  });
});
