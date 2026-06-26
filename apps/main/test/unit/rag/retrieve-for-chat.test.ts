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

describe("buildShipLookup — ship name → deck_intel/ship_intel structured fetch", () => {
  type Ents = Parameters<typeof import("@/lib/rag/retrieve-for-chat")["buildShipLookup"]>[0];
  function entities(over: Partial<Ents> = {}): Ents {
    return {
      destinations: [], departure_ports: [], cruise_lines: [], ships: [],
      travel_dates: { earliest: null, latest: null },
      passenger_composition: "", intent: "research", categories_hint: [],
      ...over,
    } as Ents;
  }

  it("returns a lookup when a ship is named (enables deck plan + amenity answers)", async () => {
    const { buildShipLookup } = await import("@/lib/rag/retrieve-for-chat");
    // WHY: "Where is The Haven on the Bliss?" returns the correct chunk only when
    // ship_lookup fires — vector search misses it because the question uses
    // amenity vocabulary, not itinerary vocabulary.
    expect(buildShipLookup(entities({ ships: ["Norwegian Bliss"] }))).toEqual({ ship: "Norwegian Bliss" });
  });

  it("returns null when no ship is mentioned (stays vector-only)", async () => {
    const { buildShipLookup } = await import("@/lib/rag/retrieve-for-chat");
    expect(buildShipLookup(entities())).toBeNull();
  });
});

describe("buildPortLookup — departure port + date → port-departure structured fetch", () => {
  type Ents = Parameters<typeof import("@/lib/rag/retrieve-for-chat")["buildPortLookup"]>[0];
  function entities(over: Partial<Ents> = {}): Ents {
    return {
      destinations: [], departure_ports: [], cruise_lines: [], ships: [],
      travel_dates: { earliest: null, latest: null },
      passenger_composition: "", intent: "research", categories_hint: [],
      ...over,
    } as Ents;
  }

  it("returns a lookup when a departure port + date are present", async () => {
    const { buildPortLookup } = await import("@/lib/rag/retrieve-for-chat");
    // WHY: "What ships leave Port Canaveral on 10/23/26?" returns Disney Wish,
    // Utopia, Fantasy only when port_lookup fires — ANN returns unrelated
    // European itinerary chunks instead.
    expect(buildPortLookup(entities({
      departure_ports: ["Port Canaveral"],
      travel_dates: { earliest: "2026-10-23", latest: null },
    }))).toEqual({ departure_port: "Port Canaveral", date_from: "2026-10-23" });
  });

  it("includes date_to when a range is given", async () => {
    const { buildPortLookup } = await import("@/lib/rag/retrieve-for-chat");
    expect(buildPortLookup(entities({
      departure_ports: ["Miami"],
      travel_dates: { earliest: "2026-06-01", latest: "2026-06-07" },
    }))).toEqual({ departure_port: "Miami", date_from: "2026-06-01", date_to: "2026-06-07" });
  });

  it("returns null without a departure port OR without a date (stays vector-only)", async () => {
    const { buildPortLookup } = await import("@/lib/rag/retrieve-for-chat");
    expect(buildPortLookup(entities({ departure_ports: ["Miami"] }))).toBeNull(); // no date
    expect(buildPortLookup(entities({ travel_dates: { earliest: "2026-06-01", latest: null } }))).toBeNull(); // no port
  });
});

describe("buildRegionLookup — region/area + date window → region structured fetch", () => {
  type Ents = Parameters<typeof import("@/lib/rag/retrieve-for-chat")["buildRegionLookup"]>[0];
  function entities(over: Partial<Ents> = {}): Ents {
    return {
      destinations: [], departure_ports: [], cruise_lines: [], ships: [],
      travel_dates: { earliest: null, latest: null },
      passenger_composition: "", intent: "research", categories_hint: [],
      ...over,
    } as Ents;
  }

  it("fires for a region + date window with no ship — the open 'Australia next spring' case", async () => {
    const { buildRegionLookup } = await import("@/lib/rag/retrieve-for-chat");
    // WHY: this is the exact query the concierge previously had no grounded answer
    // for (it fell back to a stub tool). It must expand "Australia" to its ports so
    // the rag RPC catches the NULL-region sailings that depart Australian ports.
    const lookup = buildRegionLookup(entities({
      destinations: ["Australia"],
      travel_dates: { earliest: "2027-03-01", latest: "2027-05-31" },
    }));
    expect(lookup).not.toBeNull();
    expect(lookup!.region_terms).toContain("Australia");
    expect(lookup!.port_terms).toEqual(expect.arrayContaining(["Sydney", "Brisbane", "Melbourne"]));
    expect(lookup!.date_from).toBe("2027-03-01");
    expect(lookup!.date_to).toBe("2027-05-31");
  });

  it("includes named departure ports as additional port terms (US→Australia transpacific)", async () => {
    const { buildRegionLookup } = await import("@/lib/rag/retrieve-for-chat");
    const lookup = buildRegionLookup(entities({
      destinations: ["Australia"],
      departure_ports: ["Los Angeles"],
      travel_dates: { earliest: "2027-01-01", latest: "2027-06-30" },
    }));
    // Australia's ports drive the destination-side match; the named US embark port
    // rides along as an extra term so a transpacific sailing is matchable either way.
    expect(lookup!.port_terms).toEqual(expect.arrayContaining(["Sydney", "Los Angeles"]));
  });

  it("omits date_to when only a start date is known", async () => {
    const { buildRegionLookup } = await import("@/lib/rag/retrieve-for-chat");
    const lookup = buildRegionLookup(entities({
      destinations: ["Caribbean"],
      travel_dates: { earliest: "2027-02-01", latest: null },
    }));
    expect(lookup).not.toBeNull();
    expect(lookup).not.toHaveProperty("date_to");
  });

  it("does not fire when a specific ship is named — itinerary_lookup is the precise path then", async () => {
    const { buildRegionLookup } = await import("@/lib/rag/retrieve-for-chat");
    expect(buildRegionLookup(entities({
      destinations: ["Australia"],
      ships: ["Ovation of the Seas"],
      travel_dates: { earliest: "2027-03-01", latest: "2027-05-31" },
    }))).toBeNull();
  });

  it("does not fire without a date (window must be bounded) or without a destination", async () => {
    const { buildRegionLookup } = await import("@/lib/rag/retrieve-for-chat");
    expect(buildRegionLookup(entities({ destinations: ["Australia"] }))).toBeNull(); // no date
    expect(buildRegionLookup(entities({ travel_dates: { earliest: "2027-03-01", latest: null } }))).toBeNull(); // no destination
  });
});
