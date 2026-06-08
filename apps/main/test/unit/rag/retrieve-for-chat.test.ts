// #393 / D-091 — a RAG outage or misconfig must not fail SILENTLY.
//
// callRagRetrieve runs on every chat message. On JWT-sign failure, a RAG
// non-200, a contract mismatch, or an unreachable RAG service it returns empty
// context (acceptable graceful degradation — chat still answers, ungrounded)
// but used to only console.warn. It now emits a throttled operator alert so a
// silent outage is visible, WITHOUT firing one alert per message on the hot
// path. These tests pin both halves: the alert fires, and it's throttled.
//
// resetModules per test gives each case a fresh in-process throttle map.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(async (_a: { severity: string; signal: string; detail: string }) => undefined),
  sign: vi.fn(async () => "jwt-token"),
  fetch: vi.fn(),
}));

vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: mocks.alert,
}));
vi.mock("@/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: mocks.sign,
}));
vi.mock("@/lib/rag/entity-extraction", () => ({
  extractEntities: async () => ({ destinations: [], departure_ports: [], cruise_lines: [], ships: [], travel_dates: { earliest: null, latest: null }, passenger_composition: "", intent: "research", categories_hint: [] }),
}));

const ORIG_URL = process.env.RAG_SERVICE_URL;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.sign.mockResolvedValue("jwt-token");
  process.env.RAG_SERVICE_URL = "https://rag.test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIG_URL === undefined) delete process.env.RAG_SERVICE_URL;
  else process.env.RAG_SERVICE_URL = ORIG_URL;
});

async function run() {
  const { retrieveForChat } = await import("@/lib/rag/retrieve-for-chat");
  return retrieveForChat({
    message: "hi",
    tenant_id: "t-1",
    user_id: "u-1",
    conversation_id: "c-1",
    persona_id: "p-1",
  });
}

function signalsAlerted(): string[] {
  return mocks.alert.mock.calls.map((c) => c[0].signal);
}

describe("retrieveForChat — operator alert on RAG degradation (#393)", () => {
  it("does NOT alert when RAG_SERVICE_URL is unset (test/dev path)", async () => {
    delete process.env.RAG_SERVICE_URL;
    const res = await run();
    expect(res.retrieved_chunk_ids).toEqual([]);
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("alerts (high) when JWT signing fails, still returns empty context", async () => {
    mocks.sign.mockRejectedValueOnce(new Error("bad signing key"));
    const res = await run();
    expect(res.retrieved_chunk_ids).toEqual([]);
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![0]).toMatchObject({
      severity: "high",
      signal: "rag_retrieve_jwt_sign_failed",
    });
  });

  it("alerts only ONCE across repeated non-200s (throttled), serves empty both times", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => "" } as unknown as Response);
    const a = await run();
    const b = await run();
    expect(a.retrieved_chunk_ids).toEqual([]);
    expect(b.retrieved_chunk_ids).toEqual([]);
    expect(signalsAlerted().filter((s) => s === "rag_retrieve_non_200")).toHaveLength(1);
  });

  it("alerts (medium) when the RAG service is unreachable", async () => {
    mocks.fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await run();
    expect(res.retrieved_chunk_ids).toEqual([]);
    expect(signalsAlerted()).toContain("rag_retrieve_unreachable");
  });
});

describe("buildItineraryLookup (#826) — ship+date → structured lookup params", () => {
  type Ents = Parameters<typeof import("@/lib/rag/retrieve-for-chat")["buildItineraryLookup"]>[0];
  function entities(over: Partial<Ents> = {}): Ents {
    return {
      destinations: [], departure_ports: [], cruise_lines: [], ships: [],
      travel_dates: { earliest: null, latest: null },
      passenger_composition: "", intent: "research", categories_hint: [],
      ...over,
    } as Ents;
  }

  it("returns a lookup when a ship + a start date are present", async () => {
    const { buildItineraryLookup } = await import("@/lib/rag/retrieve-for-chat");
    expect(
      buildItineraryLookup(entities({ ships: ["Norwegian Bliss"], travel_dates: { earliest: "2026-10-03", latest: null } })),
    ).toEqual({ ship: "Norwegian Bliss", sail_date_from: "2026-10-03" });
  });

  it("includes sail_date_to when the message gives a range", async () => {
    const { buildItineraryLookup } = await import("@/lib/rag/retrieve-for-chat");
    expect(
      buildItineraryLookup(entities({ ships: ["Icon of the Seas"], travel_dates: { earliest: "2026-10-01", latest: "2026-10-31" } })),
    ).toEqual({ ship: "Icon of the Seas", sail_date_from: "2026-10-01", sail_date_to: "2026-10-31" });
  });

  it("returns null without a ship OR without a date (stays vector-only)", async () => {
    const { buildItineraryLookup } = await import("@/lib/rag/retrieve-for-chat");
    expect(buildItineraryLookup(entities({ ships: [], travel_dates: { earliest: "2026-10-03", latest: null } }))).toBeNull();
    expect(buildItineraryLookup(entities({ ships: ["Wonder of the Seas"], travel_dates: { earliest: null, latest: null } }))).toBeNull();
  });
});
