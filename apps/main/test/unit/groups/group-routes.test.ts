// §7.7 / §18 — Group detail + members + broadcast (#449, #458).
//
// Contracts pinned here:
//   1. All three routes 404 (not 403/500) when the group row isn't visible —
//      RLS hiding cross-tenant rows must look the same as a truly missing
//      id (no cross-tenant existence leak).
//   2. §18.10 sailed groups are read-only: members POST and broadcast POST
//      both 410 with the sailed_at timestamp.
//   3. Broadcast renders GroupBroadcast (BrandedLayout-wrapped) per
//      recipient and reports {sent, suppressed, failed} from the
//      sendTenantNotification pipeline.
//   4. Members POST inserts one invitation row per invitee with an
//      HMAC token; zod .strict rejects unknown body keys so a malicious
//      caller can't sneak group_id/tenant_id into the payload.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  groupMaybeSingle: vi.fn(),
  invitationsBranch: vi.fn(),
  membersBranch: vi.fn(),
  membersIn: vi.fn(),
  invitationsInsert: vi.fn(),
  reserveRpc: vi.fn(),
  tenantsMaybeSingle: vi.fn(),
  brandingMaybeSingle: vi.fn(),
  assertGroupNotSailed: vi.fn(),
  sendTenantNotification: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/groups/sailed-gate", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/groups/sailed-gate")>(
      "@/lib/groups/sailed-gate",
    );
  return { ...actual, assertGroupNotSailed: mocks.assertGroupNotSailed };
});

vi.mock("@/lib/email/notifications", () => ({
  sendTenantNotification: (...args: unknown[]) =>
    mocks.sendTenantNotification(...args),
}));

vi.mock("@/lib/groups/invitation-token", () => ({
  generateToken: (id: string) => `tok-${id.slice(0, 8)}`,
}));

// #1875 — the members route calls the reserve_group_invitations RPC through a
// raw service-role client (tenantClient refuses .rpc()).
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    rpc: (name: string, args: unknown) => mocks.reserveRpc(name, args),
  }),
}));

// One tenantClient mock. The invitations branch terminal handles both:
//   - detail's `.select("rsvp_state").eq("group_id", id)` → invitationsBranch
//   - broadcast's `.select(...).eq("group_id", id).in("rsvp_state", states)` →
//     membersBranch (the .in() records the state list via membersIn).
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "groups") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.groupMaybeSingle }),
          }),
        };
      }
      if (table === "invitations") {
        const terminal = {
          then: (resolve: (v: unknown) => unknown) =>
            mocks.invitationsBranch().then(resolve),
          in: (col: string, vals: unknown) => {
            mocks.membersIn(col, vals);
            return {
              then: (resolve: (v: unknown) => unknown) =>
                mocks.membersBranch().then(resolve),
            };
          },
        };
        return {
          select: () => ({
            eq: () => terminal,
          }),
          insert: (rows: unknown) => mocks.invitationsInsert(rows),
        };
      }
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.tenantsMaybeSingle }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: mocks.brandingMaybeSingle }),
        }),
      };
    },
  }),
}));

import { GET as DETAIL_GET } from "@/app/api/groups/[id]/route";
import { POST as MEMBERS_POST } from "@/app/api/groups/[id]/members/route";
import { POST as BROADCAST_POST } from "@/app/api/groups/[id]/broadcast/route";
import { GroupSailedError } from "@/lib/groups/sailed-gate";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const GROUP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: {
      id: "u1",
      auth_user_id: "auth-1",
      tenant_id: TENANT_ID,
      status: "active",
      role: "tenant_owner",
    },
  });
  mocks.assertGroupNotSailed.mockResolvedValue(undefined);
  mocks.sendTenantNotification.mockResolvedValue({ status: "sent" });
  mocks.tenantsMaybeSingle.mockResolvedValue({
    data: { legal_name: "Acme Travel", mailing_address: "1 Main St" },
    error: null,
  });
  mocks.brandingMaybeSingle.mockResolvedValue({
    data: {
      logo_url: null,
      primary_color: "#000",
      secondary_color: null,
      accent_color: "#3b82f6",
      slogan: null,
    },
    error: null,
  });
  mocks.invitationsInsert.mockReturnValue(Promise.resolve({ error: null }));
  mocks.reserveRpc.mockResolvedValue({ data: { status: "ok", inserted: 1 }, error: null });
});

const PARAMS = { params: Promise.resolve({ id: GROUP_ID }) };

function postReq(body: unknown): Request {
  return new Request(`https://tenant.example.com/api/groups/${GROUP_ID}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq(): Request {
  return new Request(`https://tenant.example.com/api/groups/${GROUP_ID}`);
}

describe("GET /api/groups/[id]", () => {
  it("returns group + aggregated invitation counts grouped by rsvp_state (#1056)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID, status: "active" },
      error: null,
    });
    mocks.invitationsBranch.mockResolvedValue({
      data: [
        { rsvp_state: "booked" },
        { rsvp_state: "booked" },
        { rsvp_state: "pending" },
        { rsvp_state: "not_going" },
      ],
      error: null,
    });
    const res = await DETAIL_GET(getReq(), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      group: { id: string };
      invitation_counts: Record<string, number>;
    };
    expect(body.group.id).toBe(GROUP_ID);
    expect(body.invitation_counts).toEqual({ booked: 2, pending: 1, not_going: 1 });
  });

  // @rls-covered-by resources=table:public.groups target=apps/main/test/integration/rls.test.ts#RLS integration unit-scope companion policies groups: userB cannot SELECT tenantA rows
  it("returns 404 for a missing/RLS-hidden group (same shape as cross-tenant)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await DETAIL_GET(getReq(), PARAMS);
    expect(res.status).toBe(404);
  });

  it("fails loud (500) on group SELECT error", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({ data: null, error: { message: "rls" } });
    const res = await DETAIL_GET(getReq(), PARAMS);
    expect(res.status).toBe(500);
  });
});

describe("POST /api/groups/[id]/members", () => {
  it("inserts one invitation per invitee with an HMAC token; returns 201 + count", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID },
      error: null,
    });
    const res = await MEMBERS_POST(
      postReq({
        invitees: [
          { email: "a@example.com" },
          { email: "b@example.com", name: "Bee" },
        ],
      }),
      PARAMS,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { added: number; invitation_ids: string[] };
    expect(body.added).toBe(2);
    expect(body.invitation_ids).toHaveLength(2);
    // #1875 — the batch is reserved+inserted atomically by the RPC, capped at
    // MAX_INVITEES_PER_GROUP. Assert the invitee rows (with HMAC tokens) and the
    // cap parameter reach the RPC.
    const [rpcName, rpcArgs] = mocks.reserveRpc.mock.calls[0] as [
      string,
      { p_group_id: string; p_invitations: Array<{ invitee_email: string; token: string }>; p_max: number },
    ];
    expect(rpcName).toBe("reserve_group_invitations");
    expect(rpcArgs.p_group_id).toBe(GROUP_ID);
    expect(rpcArgs.p_max).toBe(50);
    expect(rpcArgs.p_invitations[0]?.invitee_email).toBe("a@example.com");
    expect(rpcArgs.p_invitations[0]?.token).toMatch(/^tok-/);
  });

  it("rejects an unknown body key via zod .strict (no group_id/tenant_id injection)", async () => {
    const res = await MEMBERS_POST(
      postReq({ invitees: [{ email: "a@example.com" }], tenant_id: "evil" }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(mocks.reserveRpc).not.toHaveBeenCalled();
  });

  it("returns 400 without reserving when the batch would exceed the cumulative cap (#1875)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID },
      error: null,
    });
    // The RPC re-counts active invitees under an advisory lock and refuses when
    // existing + batch would exceed the cap — no row is inserted.
    mocks.reserveRpc.mockResolvedValue({
      data: { status: "cap_exceeded", active_count: 49 },
      error: null,
    });
    const res = await MEMBERS_POST(
      postReq({ invitees: [{ email: "a@example.com" }, { email: "b@example.com" }] }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("50");
  });

  it("rejects malformed email via zod string().email()", async () => {
    const res = await MEMBERS_POST(
      postReq({ invitees: [{ email: "not-an-email" }] }),
      PARAMS,
    );
    expect(res.status).toBe(400);
  });

  // @rls-covered-by resources=table:public.groups target=apps/main/test/integration/rls.test.ts#RLS integration unit-scope companion policies groups: userB cannot SELECT tenantA rows
  it("returns 404 when the group isn't visible (same shape as cross-tenant)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await MEMBERS_POST(
      postReq({ invitees: [{ email: "a@example.com" }] }),
      PARAMS,
    );
    expect(res.status).toBe(404);
    expect(mocks.reserveRpc).not.toHaveBeenCalled();
  });

  it("returns 410 group_sailed when the group has sailed (§18.10)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID },
      error: null,
    });
    mocks.assertGroupNotSailed.mockRejectedValue(
      new GroupSailedError(GROUP_ID, "2026-05-01T00:00:00Z"),
    );
    const res = await MEMBERS_POST(
      postReq({ invitees: [{ email: "a@example.com" }] }),
      PARAMS,
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; sailed_at: string };
    expect(body.error).toBe("group_sailed");
    expect(body.sailed_at).toBe("2026-05-01T00:00:00Z");
    expect(mocks.reserveRpc).not.toHaveBeenCalled();
  });

  it("fails loud (500) on reserve RPC error", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID },
      error: null,
    });
    mocks.reserveRpc.mockResolvedValue({
      data: null,
      error: { message: "fk constraint" },
    });
    const res = await MEMBERS_POST(
      postReq({ invitees: [{ email: "a@example.com" }] }),
      PARAMS,
    );
    expect(res.status).toBe(500);
  });

  it("returns 409 invitee_already_invited on reserve RPC 23505 (#1895 — matches the single-invite route)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID },
      error: null,
    });
    mocks.reserveRpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    const res = await MEMBERS_POST(
      postReq({ invitees: [{ email: "a@example.com" }] }),
      PARAMS,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invitee_already_invited");
  });

  it("fails loud (500) on an unexpected reserve status — never falls through to 201", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID },
      error: null,
    });
    // A verdict that is neither "ok" nor "cap_exceeded" (e.g. a future/renamed
    // status or a malformed payload) must not be treated as success: nothing
    // may have been inserted, so a 201 would be a silent lie.
    mocks.reserveRpc.mockResolvedValue({
      data: { status: "unexpected" },
      error: null,
    });
    const res = await MEMBERS_POST(
      postReq({ invitees: [{ email: "a@example.com" }] }),
      PARAMS,
    );
    expect(res.status).toBe(500);
  });
});

describe("POST /api/groups/[id]/broadcast", () => {
  it("dispatches one sendTenantNotification per recipient and reports counts", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID, cruise_line: "Norwegian", ship_name: "Bliss", sailing_date: "2026-09-15" },
      error: null,
    });
    mocks.membersBranch.mockResolvedValue({
      data: [
        { invitee_email: "a@example.com" },
        { invitee_email: "b@example.com" },
        { invitee_email: "c@example.com" },
      ],
      error: null,
    });
    mocks.sendTenantNotification
      .mockResolvedValueOnce({ status: "sent" })
      .mockResolvedValueOnce({ status: "suppressed" })
      .mockResolvedValueOnce({ status: "sent" });

    const res = await BROADCAST_POST(
      postReq({ subject: "Hello", message: "First paragraph.\n\nSecond." }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number; suppressed: number; failed: number };
    expect(body.sent).toBe(2);
    expect(body.suppressed).toBe(1);
    expect(body.failed).toBe(0);
    expect(mocks.sendTenantNotification).toHaveBeenCalledTimes(3);
    // #1056 — omitted recipient_states → default engaged+committed audience.
    expect(mocks.membersIn).toHaveBeenCalledWith("rsvp_state", ["interested", "booked"]);
    // Verify the rendered HTML at least includes the subject string.
    const firstCall = mocks.sendTenantNotification.mock.calls[0]?.[0] as { html: string; subject: string };
    expect(firstCall.subject).toBe("Hello");
    expect(firstCall.html).toContain("Hello");
  });

  it("renders without 500 when mailing_address is a JSONB object, not a string", async () => {
    // mailing_address is a JSONB column ({line1,city,state,zip,country}). Passed
    // raw into renderToStaticMarkup it throws "Objects are not valid as a React
    // child" and the broadcast 500s. The route must coerce it to a flat string.
    mocks.tenantsMaybeSingle.mockResolvedValue({
      data: {
        legal_name: "Acme Travel",
        mailing_address: { line1: "1 Main St", city: "Miami", state: "FL", zip: "33101", country: "US" },
      },
      error: null,
    });
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID, cruise_line: "Norwegian", ship_name: "Bliss", sailing_date: "2026-09-15" },
      error: null,
    });
    mocks.membersBranch.mockResolvedValue({
      data: [{ invitee_email: "a@example.com" }],
      error: null,
    });

    const res = await BROADCAST_POST(
      postReq({ subject: "Hello", message: "Body." }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    const firstCall = mocks.sendTenantNotification.mock.calls[0]?.[0] as { html: string };
    expect(firstCall.html).toContain("1 Main St, Miami, FL 33101, US");
  });

  it("forwards explicit recipient_states to the rsvp_state filter (#1056)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID, cruise_line: null, ship_name: null, sailing_date: null },
      error: null,
    });
    mocks.membersBranch.mockResolvedValue({
      data: [{ invitee_email: "p@example.com" }],
      error: null,
    });
    const res = await BROADCAST_POST(
      postReq({ subject: "Last call", message: "RSVP please", recipient_states: ["pending"] }),
      PARAMS,
    );
    expect(res.status).toBe(200);
    expect(mocks.membersIn).toHaveBeenCalledWith("rsvp_state", ["pending"]);
  });

  it("rejects an explicit empty recipient_states array via zod (400) — broadcast to nobody is a UI error", async () => {
    const res = await BROADCAST_POST(
      postReq({ subject: "x", message: "y", recipient_states: [] }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(mocks.membersIn).not.toHaveBeenCalled();
    expect(mocks.sendTenantNotification).not.toHaveBeenCalled();
  });

  it("rejects an invalid rsvp_state value via zod (400) — e.g. the old 'accepted'", async () => {
    const res = await BROADCAST_POST(
      postReq({ subject: "x", message: "y", recipient_states: ["accepted"] }),
      PARAMS,
    );
    expect(res.status).toBe(400);
    expect(mocks.sendTenantNotification).not.toHaveBeenCalled();
  });

  it("short-circuits with 'no_recipients' when no invitations match the selected states (don't pay the render+send loop)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID, cruise_line: null, ship_name: null, sailing_date: null },
      error: null,
    });
    mocks.membersBranch.mockResolvedValue({ data: [], error: null });
    const res = await BROADCAST_POST(
      postReq({ subject: "x", message: "y" }),
      PARAMS,
    );
    const body = (await res.json()) as { sent: number; reason: string };
    expect(body.sent).toBe(0);
    expect(body.reason).toBe("no_recipients");
    expect(mocks.sendTenantNotification).not.toHaveBeenCalled();
  });

  it("returns 500 when the invitations SELECT errors (don't send to a partial/empty list)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID, cruise_line: null, ship_name: null, sailing_date: null },
      error: null,
    });
    // A failed recipient query must surface as 500, not fall through to a
    // zero-recipient "success" — that would silently drop the broadcast.
    mocks.membersBranch.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await BROADCAST_POST(
      postReq({ subject: "x", message: "y" }),
      PARAMS,
    );
    expect(res.status).toBe(500);
    expect(mocks.sendTenantNotification).not.toHaveBeenCalled();
  });

  it("returns 410 sailed for a sailed group (§18.10)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { id: GROUP_ID, cruise_line: null, ship_name: null, sailing_date: null },
      error: null,
    });
    mocks.assertGroupNotSailed.mockRejectedValue(
      new GroupSailedError(GROUP_ID, "2026-05-01T00:00:00Z"),
    );
    const res = await BROADCAST_POST(
      postReq({ subject: "x", message: "y" }),
      PARAMS,
    );
    expect(res.status).toBe(410);
    expect(mocks.sendTenantNotification).not.toHaveBeenCalled();
  });

  it("rejects empty/oversize body fields via zod", async () => {
    const res = await BROADCAST_POST(postReq({ subject: "", message: "" }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("propagates AuthForbidden (403) when assertPermission denies the broadcast action", async () => {
    const { AuthForbidden } = await import("@/lib/auth/assert-permission");
    mocks.assertPermission.mockRejectedValue(
      new AuthForbidden("groups", "broadcast", "viewer"),
    );
    const res = await BROADCAST_POST(postReq({ subject: "x", message: "y" }), PARAMS);
    expect(res.status).toBe(403);
  });
});
