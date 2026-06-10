// #732 — PATCH /api/itineraries/[id] rejects agent_notes containing control
// characters with 422. Encodes the write-time gate so a regex change or
// deletion fails here before reaching the DB.

import { describe, it, expect, beforeEach, vi } from "vitest";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ITINERARY_ID = "iiiiiiii-iiii-iiii-iiii-iiiiiiiiiiii";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  svcFrom: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: mocks.assertPermission,
}));

// Minimal service-role client: maybeSingle returns a tenant-matching row.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: mocks.svcFrom,
  }),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (err: unknown) => Response.json({ error: String(err) }, { status: 401 }),
}));

import { PATCH } from "@/app/api/itineraries/[id]/route";

function patchReq(body: Record<string, unknown>): Request {
  return new Request(`https://example.com/api/itineraries/${ITINERARY_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: USER_ID },
  });
  // Default: DB returns a matching itinerary row so the route reaches the
  // control-char check. chain calls are select → eq → eq → maybeSingle.
  const chain: Record<string, unknown> = {};
  const chainable = (): typeof chain => chain;
  chain.select = chainable;
  chain.eq = chainable;
  chain.maybeSingle = async () => ({
    data: { id: ITINERARY_ID, tenant_id: TENANT_ID, booking_id: "b1", status: "draft", access_token: "tok", agent_notes: null, bookings: null },
    error: null,
  });
  mocks.svcFrom.mockReturnValue(chain);
});

describe("PATCH /api/itineraries/[id] — agent_notes control-char gate (#732)", () => {
  it("returns 422 when agent_notes contains U+200B (zero-width space)", async () => {
    const res = await PATCH(patchReq({ agent_notes: "safe text​injection" }), {
      params: Promise.resolve({ id: ITINERARY_ID }),
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("control_characters_disallowed");
  });

  it("returns 422 when agent_notes contains a C0 control character (\\x01)", async () => {
    const res = await PATCH(patchReq({ agent_notes: "text\x01hidden" }), {
      params: Promise.resolve({ id: ITINERARY_ID }),
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("control_characters_disallowed");
  });

  it("returns 422 when agent_notes contains a bidirectional override (U+202E)", async () => {
    const res = await PATCH(patchReq({ agent_notes: "normal‮reversed" }), {
      params: Promise.resolve({ id: ITINERARY_ID }),
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("control_characters_disallowed");
  });

  it("passes 422-clean agent_notes (tab, newline, and printable text are allowed)", async () => {
    // Tab and newline are in the allowed range — the regex explicitly excludes
    // them so that multi-line notes are not rejected.
    // The route will reach the update step; mock .update chain to short-circuit.
    const updateChain: Record<string, unknown> = {};
    const chainable = (): typeof updateChain => updateChain;
    updateChain.eq = chainable;
    updateChain.select = chainable;
    updateChain.single = async () => ({
      data: { id: ITINERARY_ID },
      error: null,
    });
    const itinChain: Record<string, unknown> = {};
    const itinChainable = (): typeof itinChain => itinChain;
    itinChain.select = itinChainable;
    itinChain.eq = itinChainable;
    itinChain.maybeSingle = async () => ({
      data: { id: ITINERARY_ID, tenant_id: TENANT_ID, booking_id: "b1", status: "draft", access_token: "tok", agent_notes: null, bookings: null },
      error: null,
    });
    itinChain.update = () => updateChain;
    mocks.svcFrom.mockReturnValue(itinChain);

    const res = await PATCH(patchReq({ agent_notes: "Great trip!\n\tMeet at 9am." }), {
      params: Promise.resolve({ id: ITINERARY_ID }),
    });
    expect(res.status).not.toBe(422);
  });
});
