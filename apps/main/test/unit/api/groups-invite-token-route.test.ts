// §18.5 — request-level contract tests for /api/groups/invite/[token].
//
// This route had zero request-level coverage before the group-landing
// redesign (specs/design_handoff_group_landing/) touched it — the HMAC
// signing itself is unit-tested in invitation-token.test.ts, but the route's
// own five-check flow and response shape were never pinned.
//
// Intent under test:
//   1. Invalid HMAC / unknown invitation / revoked / expired all 400/410
//      with the right error code, before touching any other table.
//   2. The cabin-grid regression this PR fixes: an anonymous ("hidden")
//      invitee still counts toward booked/interested/pending/not_going —
//      only their *name* is withheld, never their contribution to the count.
//   3. Named roster entries respect anonymity (display "Anonymous", but are
//      still present with their real status) and never leak an email.
//   4. Itinerary/ship_stats are omitted (null) when the group has no
//      sailing_id, and populated when it does.
//   5. chat_preview is null when the group has no forum row yet.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  parseAndVerifyHmac: vi.fn(),
  invitationLookup: vi.fn(),
  groupLookup: vi.fn(),
  rosterLookup: vi.fn(),
  sailingLookup: vi.fn(),
  portCallsLookup: vi.fn(),
  shipLookup: vi.fn(),
  forumLookup: vi.fn(),
  forumMessagesRecent: vi.fn(),
  forumMessagesCount: vi.fn(),
  invitationsUpdate: vi.fn(),
}));

vi.mock("@/lib/groups/invitation-token", () => ({
  parseAndVerifyHmac: mocks.parseAndVerifyHmac,
  generateToken: (id: string) => `tok-${id}`,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "invitations") {
        return {
          select: (cols: string) => {
            if (cols.includes("token_revoked_at")) {
              // Single-invitation lookup (five-check flow).
              return { eq: () => ({ maybeSingle: mocks.invitationLookup }) };
            }
            // Roster/cabin-grid list query.
            return { eq: () => mocks.rosterLookup() };
          },
          update: () => ({
            eq: () => ({ is: () => mocks.invitationsUpdate() }),
          }),
        };
      }
      if (table === "groups") {
        return {
          select: () => ({ eq: () => ({ single: mocks.groupLookup }) }),
        };
      }
      if (table === "cruise_sailings") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mocks.sailingLookup }) }),
        };
      }
      if (table === "sailing_port_calls") {
        return {
          select: () => ({ eq: () => ({ order: mocks.portCallsLookup }) }),
        };
      }
      if (table === "cruise_ships") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mocks.shipLookup }) }),
        };
      }
      if (table === "forums") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.forumLookup }) }) }),
        };
      }
      if (table === "forum_messages") {
        return {
          select: (_cols: string, opts?: { count?: string }) => {
            if (opts?.count) {
              return { eq: () => ({ eq: () => ({ eq: () => ({ gte: mocks.forumMessagesCount }) }) }) };
            }
            return {
              eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: mocks.forumMessagesRecent }) }) }) }),
            };
          },
        };
      }
      throw new Error(`unmocked table: ${table}`);
    },
  }),
}));

async function callGet(token: string) {
  const { GET } = await import("@/app/api/groups/invite/[token]/route");
  const req = new Request(`http://localhost/api/groups/invite/${token}`);
  return GET(req, { params: Promise.resolve({ token }) });
}

const GROUP_BASE = {
  id: "grp-1",
  status: "active",
  cruise_line: "Norwegian",
  ship_name: "Bliss",
  sailing_date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  departure_port: "Seattle",
  coordinator_message: "Can't wait!",
  visibility_default: "visible" as const,
  hero_image_url: null,
  sailing_id: null as string | null,
  tenant_id: "tenant-1",
};

const INVITATION_BASE = {
  id: "inv-1",
  group_id: "grp-1",
  invitee_email: "jenna@example.com",
  invitee_name: "Jenna Rodriguez",
  rsvp_state: "booked",
  visibility_choice: "no_opinion" as const,
  token_revoked_at: null,
  token_revoked_reason: null,
  token_first_used_at: new Date().toISOString(), // already bound — skip the CAS branch
  token_bound_email: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.forumLookup.mockResolvedValue({ data: null, error: null }); // no forum row by default
});

describe("GET /api/groups/invite/[token] — five-check contract", () => {
  it("400s invalid_token on a bad HMAC before touching the DB", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "", ok: false });

    const res = await callGet("garbage");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
    expect(mocks.invitationLookup).not.toHaveBeenCalled();
  });

  it("400s invalid_token when the invitation id doesn't exist", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({ data: null, error: null });

    const res = await callGet("tok-inv-1.sig");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_token" });
  });

  it("410s token_revoked with the stored reason", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({
      data: { ...INVITATION_BASE, token_revoked_at: "2026-01-01T00:00:00Z", token_revoked_reason: "coordinator_revoked" },
      error: null,
    });

    const res = await callGet("tok-inv-1.sig");

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "token_revoked", reason: "coordinator_revoked" });
  });

  it("410s expired_natural once sailing_date + 30 days has passed, and revokes the token", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({ data: INVITATION_BASE, error: null });
    mocks.groupLookup.mockResolvedValue({
      data: { ...GROUP_BASE, sailing_date: "2020-01-01" },
      error: null,
    });
    mocks.invitationsUpdate.mockResolvedValue({ data: null, error: null });

    const res = await callGet("tok-inv-1.sig");

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "token_revoked", reason: "expired_natural" });
  });
});

describe("GET /api/groups/invite/[token] — cabin grid + roster (§18.6 anonymity)", () => {
  beforeEach(() => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({ data: INVITATION_BASE, error: null });
    mocks.groupLookup.mockResolvedValue({ data: GROUP_BASE, error: null });
  });

  it("counts an anonymous (hidden) invitee toward the aggregate stats — regression for the buildCabinGrid skip bug", async () => {
    mocks.rosterLookup.mockResolvedValue({
      data: [
        { id: "inv-1", rsvp_state: "booked", visibility_choice: "no_opinion", invitee_name: "Jenna Rodriguez" },
        { id: "inv-2", rsvp_state: "booked", visibility_choice: "be_anonymous", invitee_name: "Secret Person" },
        { id: "inv-3", rsvp_state: "interested", visibility_choice: "no_opinion", invitee_name: "Mike Torres" },
      ],
      error: null,
    });

    const res = await callGet("tok-inv-1.sig");
    const body = await res.json();

    // Both booked invitees count, even though one is anonymous.
    expect(body.cabin_grid).toMatchObject({ booked: 2, interested: 1, pending: 0, not_going: 0 });
  });

  it("names non-anonymous roster entries and masks anonymous ones as 'Anonymous', without ever exposing an email", async () => {
    mocks.rosterLookup.mockResolvedValue({
      data: [
        { id: "inv-1", rsvp_state: "booked", visibility_choice: "no_opinion", invitee_name: "Jenna Rodriguez" },
        { id: "inv-2", rsvp_state: "booked", visibility_choice: "be_anonymous", invitee_name: "Secret Person" },
      ],
      error: null,
    });

    const res = await callGet("tok-inv-1.sig");
    const body = await res.json();

    const named = body.roster.find((r: { id: string }) => r.id === "inv-1");
    const anon = body.roster.find((r: { id: string }) => r.id === "inv-2");
    expect(named).toMatchObject({ displayName: "Jenna R.", anonymous: false, status: "booked" });
    expect(anon).toMatchObject({ displayName: "Anonymous", anonymous: true, status: "booked" });
    expect(JSON.stringify(body.roster)).not.toContain("@example.com");
  });
});

describe("GET /api/groups/invite/[token] — itinerary/ship_stats/chat_preview omission", () => {
  beforeEach(() => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
    mocks.invitationLookup.mockResolvedValue({ data: INVITATION_BASE, error: null });
    mocks.rosterLookup.mockResolvedValue({ data: [INVITATION_BASE], error: null });
  });

  it("omits itinerary and ship_stats entirely for a legacy free-text group (no sailing_id)", async () => {
    mocks.groupLookup.mockResolvedValue({ data: { ...GROUP_BASE, sailing_id: null }, error: null });

    const res = await callGet("tok-inv-1.sig");
    const body = await res.json();

    expect(body.itinerary).toBeNull();
    expect(body.ship_stats).toBeNull();
    expect(mocks.sailingLookup).not.toHaveBeenCalled();
  });

  it("populates itinerary and ship_stats for a catalog-linked group", async () => {
    mocks.groupLookup.mockResolvedValue({ data: { ...GROUP_BASE, sailing_id: "sail-1" }, error: null });
    mocks.sailingLookup.mockResolvedValue({ data: { cruise_ship_id: "ship-1" }, error: null });
    mocks.portCallsLookup.mockResolvedValue({
      data: [
        { port_name: "Seattle, WA", day_index: 0 },
        { port_name: "Cruising Inside Passage", day_index: 1 },
      ],
      error: null,
    });
    mocks.shipLookup.mockResolvedValue({
      data: { guest_capacity: 4004, decks: 20, built_year: 2018, signature_feature: null },
      error: null,
    });

    const res = await callGet("tok-inv-1.sig");
    const body = await res.json();

    expect(body.itinerary).toEqual([
      { dayLabel: "Day 1", portName: "Seattle, WA", arrival: null, departure: null, isSeaDay: false },
      { dayLabel: "Day 2", portName: "Cruising Inside Passage", arrival: null, departure: null, isSeaDay: true },
    ]);
    expect(body.ship_stats).toEqual({ guestCapacity: 4004, decks: 20, builtYear: 2018, signatureFeature: null });
  });

  it("returns chat_preview: null when the group has no forum row yet", async () => {
    mocks.groupLookup.mockResolvedValue({ data: { ...GROUP_BASE, sailing_id: null }, error: null });
    mocks.forumLookup.mockResolvedValue({ data: null, error: null });

    const res = await callGet("tok-inv-1.sig");
    const body = await res.json();

    expect(body.chat_preview).toBeNull();
  });

  it("returns the two most recent visible messages and this-week total when a forum exists", async () => {
    mocks.groupLookup.mockResolvedValue({ data: { ...GROUP_BASE, sailing_id: null }, error: null });
    mocks.forumLookup.mockResolvedValue({ data: { id: "forum-1" }, error: null });
    mocks.forumMessagesRecent.mockResolvedValue({
      data: [
        { id: "m-1", content: "Just booked our excursion!", created_at: "2026-06-30T10:00:00Z", users: { display_name: "Priya K.", first_name: null, last_name: null } },
      ],
      error: null,
    });
    mocks.forumMessagesCount.mockResolvedValue({ count: 18, error: null });

    const res = await callGet("tok-inv-1.sig");
    const body = await res.json();

    expect(body.chat_preview).toEqual({
      messages: [{ id: "m-1", authorName: "Priya K.", text: "Just booked our excursion!", timestamp: "2026-06-30T10:00:00Z" }],
      totalThisWeek: 18,
    });
  });
});
