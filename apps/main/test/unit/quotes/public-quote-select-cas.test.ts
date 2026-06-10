// #741 — POST /api/public/quote/[token]/select
// CAS guard: concurrent acceptance must return 409 quote_status_changed_during_accept
// instead of silently no-op'ing.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = {
  safeAwaitRowCount: vi.fn(),
};

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return { ...actual, safeAwaitRowCount: mocks.safeAwaitRowCount };
});

// DB mock: SELECT resolves the token to a 'sent' quote; UPDATE chain is a
// chainable proxy passed to the mocked safeAwaitRowCount.
const updateChain = new Proxy({} as Record<string | symbol, unknown>, {
  get(_t, prop) {
    if (prop === "then") return undefined;
    return () => updateChain;
  },
});

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "quotes") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "q-1", tenant_id: "t-1", status: "sent" },
                error: null,
              }),
            }),
          }),
          update: () => updateChain,
        };
      }
      if (table === "quote_options") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "opt-1", quote_id: "q-1" },
                error: null,
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              then: (r: (v: { error: null }) => unknown) => Promise.resolve(r({ error: null })),
            }),
          }),
        };
      }
      return {};
    },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  mocks.safeAwaitRowCount.mockResolvedValue([{ id: "q-1" }]);
});

async function postSelect(token = "tok-1", optionId = "opt-1"): Promise<Response> {
  const { POST } = await import("@/app/api/public/quote/[token]/select/route");
  return POST(
    new Request(`http://test/api/public/quote/${token}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option_id: optionId }),
    }),
    { params: Promise.resolve({ token }) },
  );
}

describe("POST /api/public/quote/[token]/select — CAS guard (#741)", () => {
  it("returns 409 quote_status_changed_during_accept when quote was accepted concurrently", async () => {
    const { SupabaseMutationError } = await import("@/lib/db/safe-mutation");
    mocks.safeAwaitRowCount.mockRejectedValue(
      new SupabaseMutationError("quotes.cas_accept_via_token", {
        message: "Expected 1 row(s); got 0.",
        code: "ROW_COUNT_MISMATCH",
        hint: "",
        details: null,
        name: "RowCountMismatch",
      } as never),
    );
    const res = await postSelect();
    expect(res.status).toBe(409);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toBe("quote_status_changed_during_accept");
  });

  it("returns 200 ok on successful selection", async () => {
    const res = await postSelect();
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
  });

  it("returns 400 when option_id is missing", async () => {
    const { POST } = await import("@/app/api/public/quote/[token]/select/route");
    const res = await POST(
      new Request("http://test/api/public/quote/tok-1/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ token: "tok-1" }) },
    );
    expect(res.status).toBe(400);
  });
});
