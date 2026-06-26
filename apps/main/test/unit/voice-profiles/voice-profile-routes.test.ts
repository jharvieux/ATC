// #1267 — Regression guard for voice-profile route registrations.
//
// WHY: voice_samples and voice_profiles were missing from TENANT_SCOPED_TABLES,
// which caused tenantClient.from() to throw UnregisteredTenantTableError on
// every request to GET /api/voice-profiles/samples, POST /api/voice-profiles/samples,
// PATCH /api/voice-profiles/card, and DELETE /api/voice-profiles/samples/[id].
// The whole feature was dead in prod.
//
// These tests pin two things:
//   1. TENANT_SCOPED_TABLES membership — fails immediately if either table is
//      removed from the set, catching the regression before it reaches CI.
//   2. Route happy-path contracts — GET returns 200 with samples + profile,
//      POST returns 201 with new id. If the tenantClient mock is swapped for
//      a real one backed by a test DB, the TENANT_SCOPED_TABLES membership
//      test guarantees voice_samples/voice_profiles must be registered or the
//      real tenantClient throws UnregisteredTenantTableError.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TENANT_SCOPED_TABLES } from "@/lib/db/tenant-scoped-tables";

// ── 1. Table registration guard ─────────────────────────────────────────────

describe("TENANT_SCOPED_TABLES registration (#1267)", () => {
  it("contains voice_samples", () => {
    expect(TENANT_SCOPED_TABLES.has("voice_samples")).toBe(true);
  });

  it("contains voice_profiles", () => {
    expect(TENANT_SCOPED_TABLES.has("voice_profiles")).toBe(true);
  });
});

// ── 2. Route happy-path tests ───────────────────────────────────────────────

const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const AUTH_USER_ID = "auth-user-1";
const PUBLIC_USER_ID = "pub-user-1";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  // tenantClient query stubs — keyed by (table, op) pattern.
  usersMaybeSingle: vi.fn(),
  // Own-samples: select().order().eq() — matches the route's ownBase chain.
  ownSampleSelectEq: vi.fn(),
  // Own-samples: select().order().is() — used when publicUserId is null.
  ownSampleSelectIs: vi.fn(),
  // House-samples: select().is().order() — tenant_owner only.
  houseSampleSelect: vi.fn(),
  cardMaybeSingle: vi.fn(),
  houseCardMaybeSingle: vi.fn(),
  sampleInsertSingle: vi.fn(),
  inngestSend: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: mocks.assertPermission,
}));

// The tenantClient mock fully controls query chain responses by table name.
// If voice_samples or voice_profiles were removed from TENANT_SCOPED_TABLES the
// REAL tenantClient would throw here; these tests use a full mock so the
// TENANT_SCOPED_TABLES membership test (section 1 above) is the regression pin.
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.usersMaybeSingle }),
          }),
        };
      }
      if (table === "voice_samples") {
        return {
          select: () => ({
            // Route's ownBase: select().order(), then .eq() or .is() for user filtering.
            order: () => ({
              eq: () => mocks.ownSampleSelectEq(),
              is: () => mocks.ownSampleSelectIs(),
            }),
            // House-samples: select().is().order() (tenant_owner branch).
            is: () => ({
              order: () => mocks.houseSampleSelect(),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: mocks.sampleInsertSingle,
            }),
          }),
        };
      }
      if (table === "voice_profiles") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.cardMaybeSingle }),
            is: () => ({ maybeSingle: mocks.houseCardMaybeSingle }),
          }),
        };
      }
      throw new Error(`Unexpected table in test mock: ${table}`);
    },
  }),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (_err: unknown) =>
    Response.json({ error: "unauthorized" }, { status: 401 }),
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.inngestSend },
}));

vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: (_err: unknown) =>
    Response.json({ error: "db_error" }, { status: 500 }),
}));

// ── GET /api/voice-profiles/samples ─────────────────────────────────────────

import { GET, POST } from "@/app/api/voice-profiles/samples/route";

const CTX = {
  tenant_id: TENANT_ID,
  source: { kind: "http_request" as const, user_id: AUTH_USER_ID },
};

function makeGetRequest(): Request {
  return new Request("http://example.com/api/voice-profiles/samples");
}

function makePostRequest(body: unknown): Request {
  return new Request("http://example.com/api/voice-profiles/samples", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.assertPermission.mockResolvedValue({ ctx: CTX });

  // Default user row: agent role (not tenant_owner so house samples skip).
  mocks.usersMaybeSingle.mockResolvedValue({
    data: { id: PUBLIC_USER_ID, role: "agent" },
    error: null,
  });

  // Default own samples — one sample (select().order().eq() path).
  mocks.ownSampleSelectEq.mockResolvedValue({
    data: [{ id: "s1", body: "My sample", source_label: "Email", created_at: "2026-01-01" }],
    error: null,
  });

  // Default own samples via .is() path (null publicUserId — structurally
  // unreachable from the GET route given assertPermission requires a session,
  // but wired for completeness).
  mocks.ownSampleSelectIs.mockResolvedValue({ data: [], error: null });

  // House samples empty by default.
  mocks.houseSampleSelect.mockResolvedValue({ data: [], error: null });

  // Profile card present.
  mocks.cardMaybeSingle.mockResolvedValue({
    data: { style_card: { greeting: "Hello" }, card_override: null, extracted_at: "2026-01-01", samples_hash: "abc" },
    error: null,
  });

  mocks.houseCardMaybeSingle.mockResolvedValue({ data: null, error: null });

  // Insert returns new id.
  mocks.sampleInsertSingle.mockResolvedValue({
    data: { id: "new-sample-id" },
    error: null,
  });
});

describe("GET /api/voice-profiles/samples (#1267)", () => {
  it("returns 200 with own_samples and profile for authenticated agent", async () => {
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      own_samples: unknown[];
      house_samples: unknown[];
      profile: unknown;
      is_owner: boolean;
    };
    expect(body.own_samples).toBeInstanceOf(Array);
    expect(body.house_samples).toBeInstanceOf(Array);
    expect(body.is_owner).toBe(false);
  });

  it("returns profile card when one exists", async () => {
    const res = await GET(makeGetRequest());
    const body = await res.json() as { profile: { style_card: unknown } | null };
    expect(body.profile).not.toBeNull();
    expect(body.profile?.style_card).toEqual({ greeting: "Hello" });
  });

  it("returns 500 when user lookup fails", async () => {
    mocks.usersMaybeSingle.mockResolvedValue({ data: null, error: { message: "db error" } });
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
  });

  it("returns 401 when assertPermission throws", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("Unauthorized"));
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });
});

// ── POST /api/voice-profiles/samples ────────────────────────────────────────

const VALID_SAMPLE_BODY = "A".repeat(60); // 60 chars, within 50–8000 range.

describe("POST /api/voice-profiles/samples (#1267)", () => {
  it("returns 201 with new sample id on valid payload", async () => {
    const res = await POST(makePostRequest({ body: VALID_SAMPLE_BODY, source_label: "Email" }));
    expect(res.status).toBe(201);
    const json = await res.json() as { id: string };
    expect(json.id).toBe("new-sample-id");
  });

  it("dispatches voice_profile.extraction_requested inngest event", async () => {
    await POST(makePostRequest({ body: VALID_SAMPLE_BODY }));
    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "voice_profile.extraction_requested" }),
    );
  });

  it("returns 400 when body is too short (< 50 chars)", async () => {
    const res = await POST(makePostRequest({ body: "too short" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is too long (> 8000 chars)", async () => {
    const res = await POST(makePostRequest({ body: "B".repeat(8001) }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid json", async () => {
    const req = new Request("http://example.com/api/voice-profiles/samples", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 403 when non-owner tries to add a house-style sample", async () => {
    const res = await POST(makePostRequest({ body: VALID_SAMPLE_BODY, is_house_style: true }));
    expect(res.status).toBe(403);
  });

  it("returns 500 when user lookup fails", async () => {
    mocks.usersMaybeSingle.mockResolvedValue({ data: null, error: { message: "db error" } });
    const res = await POST(makePostRequest({ body: VALID_SAMPLE_BODY }));
    expect(res.status).toBe(500);
  });

  it("returns 500 when insert fails", async () => {
    mocks.sampleInsertSingle.mockResolvedValue({ data: null, error: { message: "insert failed" } });
    const res = await POST(makePostRequest({ body: VALID_SAMPLE_BODY }));
    expect(res.status).toBe(500);
  });

  it("returns 401 when assertPermission throws", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("Unauthorized"));
    const res = await POST(makePostRequest({ body: VALID_SAMPLE_BODY }));
    expect(res.status).toBe(401);
  });
});
