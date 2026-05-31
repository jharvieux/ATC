// #487 — getSailingItinerary null-safety invariants.
//
// The function must return null on every failure mode so buildAndSend
// degrades gracefully rather than throwing and dropping the email.
// Tests cover: RAG_SERVICE_URL unset, JWT failure, network error,
// non-OK response, 404, malformed JSON, and the success path.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  jwtResult: "signed.jwt.token" as string | null,
  fetchResult: null as Response | null,
  fetchThrows: false,
  RAG_SERVICE_URL: "https://rag.internal",
}));

vi.mock("@/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: async () => {
    if (mocks.jwtResult === null) throw new Error("JWT signing failed");
    return mocks.jwtResult;
  },
}));

vi.mock("@/lib/rag-auth/platform-sentinel", () => ({
  PLATFORM_SENTINEL_TENANT_ID: "platform",
}));

// Replace global fetch so tests don't hit the network.
const originalFetch = globalThis.fetch;

beforeEach(() => {
  mocks.jwtResult = "signed.jwt.token";
  mocks.fetchResult = null;
  mocks.fetchThrows = false;
  process.env.RAG_SERVICE_URL = mocks.RAG_SERVICE_URL;

  globalThis.fetch = vi.fn(async () => {
    if (mocks.fetchThrows) throw new Error("Network error");
    return mocks.fetchResult!;
  });
});

afterEach(() => {
  delete process.env.RAG_SERVICE_URL;
  globalThis.fetch = originalFetch;
});

import { getSailingItinerary } from "@/lib/sailings/sailing-itinerary";

const ARGS = { cruise_line: "NCL", ship_name: "Bliss", sailing_date: "2026-08-28" };

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getSailingItinerary — null-safe failure modes", () => {
  it("returns null when RAG_SERVICE_URL is unset", async () => {
    delete process.env.RAG_SERVICE_URL;
    expect(await getSailingItinerary(ARGS)).toBeNull();
  });

  it("returns null when JWT signing throws", async () => {
    mocks.jwtResult = null;
    expect(await getSailingItinerary(ARGS)).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    mocks.fetchThrows = true;
    expect(await getSailingItinerary(ARGS)).toBeNull();
  });

  it("returns null on HTTP 404", async () => {
    mocks.fetchResult = makeResponse(null, 404);
    expect(await getSailingItinerary(ARGS)).toBeNull();
  });

  it("returns null on HTTP 500", async () => {
    mocks.fetchResult = makeResponse({ error: "db_error" }, 500);
    expect(await getSailingItinerary(ARGS)).toBeNull();
  });

  it("returns null when the response body is null", async () => {
    mocks.fetchResult = makeResponse(null);
    expect(await getSailingItinerary(ARGS)).toBeNull();
  });

  it("returns null when JSON parse fails", async () => {
    mocks.fetchResult = new Response("not-json", { status: 200 });
    expect(await getSailingItinerary(ARGS)).toBeNull();
  });
});

describe("getSailingItinerary — success path", () => {
  it("returns ports_of_call and days from the API response", async () => {
    mocks.fetchResult = makeResponse({
      ports_of_call: ["Roatán", "Cozumel"],
      day_by_day: [
        { day_number: 1, date: "2026-08-28", port_name: null },
        { day_number: 2, date: "2026-08-29", port_name: "Roatán" },
      ],
      region: "Caribbean Cruise",
    });
    const result = await getSailingItinerary(ARGS);
    expect(result).not.toBeNull();
    expect(result?.ports_of_call).toEqual(["Roatán", "Cozumel"]);
    expect(result?.days).toHaveLength(2);
  });

  it("surfaces the cruisemapper_region from the region column", async () => {
    mocks.fetchResult = makeResponse({
      ports_of_call: ["Nassau"],
      day_by_day: null,
      region: "Bahamas Cruise",
    });
    const result = await getSailingItinerary(ARGS);
    expect(result?.cruisemapper_region).toBe("Bahamas Cruise");
  });

  it("defaults ports_of_call to [] when missing from response", async () => {
    mocks.fetchResult = makeResponse({ day_by_day: null });
    const result = await getSailingItinerary(ARGS);
    expect(result?.ports_of_call).toEqual([]);
  });

  it("defaults days to [] when day_by_day is null", async () => {
    mocks.fetchResult = makeResponse({ ports_of_call: ["Nassau"], day_by_day: null });
    const result = await getSailingItinerary(ARGS);
    expect(result?.days).toEqual([]);
  });

  it("passes cruise_line, ship, departure_date as query params", async () => {
    mocks.fetchResult = makeResponse({ ports_of_call: [], day_by_day: null });
    await getSailingItinerary(ARGS);
    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("cruise_line=NCL");
    expect(calledUrl).toContain("ship=Bliss");
    expect(calledUrl).toContain("departure_date=2026-08-28");
  });

  it("sends the JWT in the Authorization header", async () => {
    mocks.fetchResult = makeResponse({ ports_of_call: [], day_by_day: null });
    await getSailingItinerary(ARGS);
    const calledInit = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect((calledInit.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer signed.jwt.token",
    );
  });
});
