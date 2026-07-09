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

const mocks = vi.hoisted(() => {
  const emptyEntities = {
    destinations: [], departure_ports: [], cruise_lines: [], ships: [],
    travel_dates: { earliest: null, latest: null },
    passenger_composition: "", intent: "research", categories_hint: [],
  };
  return {
    alert: vi.fn(async (_a: { severity: string; signal: string; detail: string }) => undefined),
    sign: vi.fn(async () => "jwt-token"),
    fetch: vi.fn(),
    extractEntities: vi.fn(async () => emptyEntities),
    emptyEntities,
  };
});

vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: mocks.alert,
}));
vi.mock("@/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: mocks.sign,
}));
vi.mock("@/lib/rag/entity-extraction", () => ({
  extractEntities: mocks.extractEntities,
}));

const ORIG_URL = process.env.RAG_SERVICE_URL;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.sign.mockResolvedValue("jwt-token");
  mocks.extractEntities.mockResolvedValue(mocks.emptyEntities);
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
    expect(lookup!.origin_port_terms).toEqual([]); // no origin named → no origin constraint
    expect(lookup!.date_from).toBe("2027-03-01");
    expect(lookup!.date_to).toBe("2027-05-31");
  });

  it("puts a named departure origin in origin_port_terms, not the destination match (US→Australia)", async () => {
    const { buildRegionLookup } = await import("@/lib/rag/retrieve-for-chat");
    const lookup = buildRegionLookup(entities({
      destinations: ["Australia"],
      departure_ports: ["United States"],
      travel_dates: { earliest: "2027-01-01", latest: "2027-06-30" },
    }));
    // WHY: "from the US to Australia" must show only sailings that START in the US.
    // Australia drives the destination match; "United States" expands to US embark
    // ports as an ORIGIN constraint — it must NOT leak into the destination terms
    // (that would match sailings merely VISITING a US port).
    expect(lookup!.port_terms).toContain("Sydney");
    expect(lookup!.port_terms).not.toContain("Miami");
    expect(lookup!.origin_port_terms).toEqual(expect.arrayContaining(["Miami", "Los Angeles", "Seward"]));
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

// #1551 — the structuredLookupDescription branch (retrieve-for-chat.ts:191-206)
// decides WHAT the agent is told a sailing search covered when a structured
// lookup fired but the RAG service returned zero chunks. Every prior test in
// this file stubs extractEntities to always-empty, so sailingLookupAttempted
// is always false and this string-building code never runs. If a future edit
// dropped a field from one of these descriptions (e.g. forgot cruise_lines on
// the region branch), the persona would tell the customer a narrower search
// ran than actually did — these tests pin the exact text per branch so that
// regression is caught at the unit level instead of only in a live chat.
describe("structuredLookupDescription — sailing-search description builder (#1551)", () => {
  function emptyRetrieveResponse(): void {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null }),
    } as unknown as Response);
  }

  async function runWithEntities(over: Partial<typeof mocks.emptyEntities>) {
    mocks.extractEntities.mockResolvedValueOnce({ ...mocks.emptyEntities, ...over });
    emptyRetrieveResponse();
    const { retrieveForChat } = await import("@/lib/rag/retrieve-for-chat");
    return retrieveForChat({
      message: "test message",
      tenant_id: "t-1",
      user_id: "u-1",
      conversation_id: "c-1",
      persona_id: "p-1",
    });
  }

  it("itinerary branch: describes ship + sail_date_from (no chunks found)", async () => {
    const res = await runWithEntities({
      ships: ["Norwegian Bliss"],
      travel_dates: { earliest: "2026-10-03", latest: null },
    });
    expect(res.knowledge_block).toContain(
      "A sailing search was performed (Norwegian Bliss itinerary, from 2026-10-03)",
    );
  });

  it("itinerary branch: includes sail_date_to when the message gave a range", async () => {
    const res = await runWithEntities({
      ships: ["Icon of the Seas"],
      travel_dates: { earliest: "2026-10-01", latest: "2026-10-31" },
    });
    expect(res.knowledge_block).toContain(
      "A sailing search was performed (Icon of the Seas itinerary, from 2026-10-01 to 2026-10-31)",
    );
  });

  it("region branch: describes destinations + date window (no ship, no cruise line named)", async () => {
    const res = await runWithEntities({
      destinations: ["Australia"],
      travel_dates: { earliest: "2027-03-01", latest: "2027-05-31" },
    });
    expect(res.knowledge_block).toContain(
      "A sailing search was performed (Australia, 2027-03-01 to 2027-05-31)",
    );
  });

  it("region branch: folds in cruise_lines and uses 'onward' when only a start date is known", async () => {
    const res = await runWithEntities({
      destinations: ["Caribbean"],
      cruise_lines: ["Royal Caribbean"],
      travel_dates: { earliest: "2027-02-01", latest: null },
    });
    expect(res.knowledge_block).toContain(
      "A sailing search was performed (Caribbean, on Royal Caribbean, 2027-02-01 onward)",
    );
  });

  it("port branch: describes departure_port + date_from (no ship, no destination named)", async () => {
    const res = await runWithEntities({
      departure_ports: ["Miami"],
      travel_dates: { earliest: "2026-06-01", latest: null },
    });
    expect(res.knowledge_block).toContain(
      "A sailing search was performed (departing Miami, from 2026-06-01)",
    );
  });

  it("port branch: includes date_to when a range is given", async () => {
    const res = await runWithEntities({
      departure_ports: ["Port Canaveral"],
      travel_dates: { earliest: "2026-10-23", latest: "2026-10-30" },
    });
    expect(res.knowledge_block).toContain(
      "A sailing search was performed (departing Port Canaveral, from 2026-10-23 to 2026-10-30)",
    );
  });

  it("no structured lookup fired: falls back to the plain no-result block, not a search description", async () => {
    // Entities stay empty (default mock) — itinerary/region/port lookups all
    // return null, so sailingLookupAttempted is false and formatKnowledgeBlock
    // must get no structuredLookupDescription at all.
    emptyRetrieveResponse();
    const { retrieveForChat } = await import("@/lib/rag/retrieve-for-chat");
    const res = await retrieveForChat({
      message: "hi",
      tenant_id: "t-1",
      user_id: "u-1",
      conversation_id: "c-1",
      persona_id: "p-1",
    });
    expect(res.knowledge_block).toContain("No retrieved chunks");
    expect(res.knowledge_block).not.toContain("A sailing search was performed");
  });
});
