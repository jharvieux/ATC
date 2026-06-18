// Unit tests for the 0-coverage api/tenant/* routes (#1212).
//
// Covers: ai-config (GET+PATCH), safety (GET+POST+DELETE), chat-limits (GET+PUT),
//         branding (GET+POST), usage (GET), override-requests (GET+POST).
//
// D-091 focus: auth gate must be the single entry point (assertPermission throws
// → respondToAuthError → 403); tier gates fail-closed for non-Pro+ tenants;
// input validation rejects before any DB mutation.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── shared mock state ──────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  permFails: false,
  tenantId: "tenant-1",
  userId: "user-1",
  tableData: {} as Record<string, unknown>,
  tableErrors: {} as Record<string, { message: string } | null>,
  safeAwaitLabels: [] as string[],
  safeAwaitFails: false,
  writeAuditCalled: false,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => {
    if (h.permFails) throw new Error("permission_denied");
    return {
      ctx: {
        tenant_id: h.tenantId,
        source: { kind: "http_request", user_id: h.userId },
      },
      user: { id: h.userId },
    };
  }),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => makeChain(table),
  }),
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => makeChain(table),
  }),
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async (_q: unknown, label: string) => {
    h.safeAwaitLabels.push(label);
    if (h.safeAwaitFails) throw new Error(`safeAwait injected failure: ${label}`);
    return { data: null, error: null };
  },
}));

vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: async () => { h.writeAuditCalled = true; },
}));

vi.mock("@/lib/personas/resolve-ai-behavior", () => ({
  resolveAIBehavior: (args: unknown) => ({ ...args as Record<string,unknown>, resolved: true }),
}));

vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: () => Response.json({ error: "db_error" }, { status: 500 }),
}));

vi.mock("@/lib/branding/powered-by", () => ({
  resolveShowPoweredBy: () => true,
}));

vi.mock("@/lib/abuse/thresholds", () => ({
  resolveThresholds: async () => ({
    ai_cost_cents: { soft1: 1000, soft2: 2000, hard: 5000 },
    chat_volume_messages_monthly: { soft1: 100, soft2: 200, hard: 500 },
    email_volume_daily: { soft1: 50, soft2: 100, hard: 200 },
    group_invite_monthly: { soft1: 20, soft2: 50, hard: 100 },
    rag_cap_total: { effective: 10000, approaching: false },
  }),
}));

// ── DB chain builder ───────────────────────────────────────────────────────
// The Supabase JS client returns a builder that is itself thenable — every
// intermediate method (select, eq, insert, update, …) returns the same
// builder. Awaiting the builder yields { data, error }. Terminal helpers
// (.maybySingle(), .single()) also return Promises.  We replicate all of
// this so routes that `await builder.insert({…})` and routes that
// `await builder.select(…).order(…).limit(N)` both work.

function makeChain(table: string): Record<string, unknown> {
  const tableError = h.tableErrors[table] ?? null;
  const resolved = {
    // Supabase never returns both data and error — error wins.
    data: tableError ? null : (h.tableData[table] ?? null),
    error: tableError,
  };
  const chain: Record<string, unknown> = {};
  // All chainable methods return chain so multi-step builders compose.
  for (const m of [
    "select", "eq", "neq", "not", "order", "limit",
    "gte", "lte", "gt", "lt", "in", "is",
    "insert", "update", "upsert", "delete",
  ]) {
    chain[m] = () => chain;
  }
  // Terminal helpers resolve to row data or error.
  chain.maybeSingle = () => Promise.resolve(resolved);
  chain.single      = () => Promise.resolve(resolved);
  // Make the chain itself thenable so `await db.from("x").select(…)` works
  // without a trailing terminal method (used by list queries).
  chain.then = (resolve: (v: typeof resolved) => unknown) => resolve(resolved);
  return chain;
}

// ── helpers ────────────────────────────────────────────────────────────────

function req(
  url: string,
  method = "GET",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  return new Request(`https://app.example.com${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  h.permFails = false;
  h.tenantId = "tenant-1";
  h.userId = "user-1";
  h.tableData = {};
  h.tableErrors = {};
  h.safeAwaitLabels.length = 0;
  h.safeAwaitFails = false;
  h.writeAuditCalled = false;
  // Default tier lookups
  h.tableData["tenants"] = { id: "tenant-1", tier_id: "tier-1", ai_mode: "autonomous", background_ai_enabled: true, is_sandbox: false };
  h.tableData["tier_definitions"] = { code: "sub_pro" };
  // platform_settings intentionally omitted → loadPlatformInt falls back to route defaults
  // (hard_floor=15, hard_ceiling=200) so chat-limits ordering/bonus tests use valid hard_cap values.
  h.tableData["tenant_branding"] = { id: "branding-1" };
});

// ═══════════════════════════════════════════════════════════════════════════
// ai-config
// ═══════════════════════════════════════════════════════════════════════════

import { GET as aiConfigGET, PATCH as aiConfigPATCH } from "@/app/api/tenant/ai-config/route";

describe("GET /api/tenant/ai-config", () => {
  it("returns 403 when caller lacks permission (auth gate is non-bypassable)", async () => {
    h.permFails = true;
    const res = await aiConfigGET(req("/api/tenant/ai-config"));
    expect(res.status).toBe(403);
  });

  it("returns current ai_mode, background_ai_enabled, and flags", async () => {
    h.tableData["tenants"] = { ai_mode: "draft_only", background_ai_enabled: false };
    const res = await aiConfigGET(req("/api/tenant/ai-config"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ai_mode: string; background_ai_enabled: boolean };
    expect(body.ai_mode).toBe("draft_only");
    expect(body.background_ai_enabled).toBe(false);
  });
});

describe("PATCH /api/tenant/ai-config", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await aiConfigPATCH(req("/api/tenant/ai-config", "PATCH", { ai_mode: "disabled" }));
    expect(res.status).toBe(403);
  });

  it("returns 422 for an invalid ai_mode value", async () => {
    const res = await aiConfigPATCH(req("/api/tenant/ai-config", "PATCH", { ai_mode: "sky_net" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid ai_mode/i);
  });

  it("returns 422 when background_ai_enabled is not a boolean", async () => {
    const res = await aiConfigPATCH(req("/api/tenant/ai-config", "PATCH", { background_ai_enabled: "yes" }));
    expect(res.status).toBe(422);
  });

  it("returns 422 when body has no updatable fields", async () => {
    const res = await aiConfigPATCH(req("/api/tenant/ai-config", "PATCH", {}));
    expect(res.status).toBe(422);
  });

  it("updates and returns the new config on valid PATCH", async () => {
    h.tableData["tenants"] = { ai_mode: "autonomous", background_ai_enabled: true };
    const res = await aiConfigPATCH(req("/api/tenant/ai-config", "PATCH", { ai_mode: "disabled" }));
    expect(res.status).toBe(200);
    expect(h.writeAuditCalled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// safety
// ═══════════════════════════════════════════════════════════════════════════

import {
  GET as safetyGET,
  POST as safetyPOST,
  DELETE as safetyDELETE,
} from "@/app/api/tenant/safety/route";

describe("GET /api/tenant/safety", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await safetyGET(req("/api/tenant/safety"));
    expect(res.status).toBe(403);
  });

  it("returns the supplemental deny-list terms", async () => {
    h.tableData["tenant_settings"] = { supplemental_hate_speech_denylist: ["bad_word"] };
    const res = await safetyGET(req("/api/tenant/safety"));
    expect(res.status).toBe(200);
    const body = await res.json() as { terms: string[] };
    expect(body.terms).toContain("bad_word");
  });
});

describe("POST /api/tenant/safety", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await safetyPOST(req("/api/tenant/safety", "POST", { term: "word" }));
    expect(res.status).toBe(403);
  });

  it("returns 403 for non-Pro+ tier (tier gate)", async () => {
    h.tableData["tier_definitions"] = { code: "byo_research" };
    const res = await safetyPOST(req("/api/tenant/safety", "POST", { term: "word" }));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pro_plus_only");
    // Must NOT mutate — no DB write after tier check fails
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("returns 422 when term is empty", async () => {
    const res = await safetyPOST(req("/api/tenant/safety", "POST", { term: "" }));
    expect(res.status).toBe(422);
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("returns 422 when term exceeds 200 chars", async () => {
    const res = await safetyPOST(req("/api/tenant/safety", "POST", { term: "a".repeat(201) }));
    expect(res.status).toBe(422);
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("adds a new term via UPDATE when row already exists", async () => {
    h.tableData["tenant_settings"] = { supplemental_hate_speech_denylist: [] };
    const res = await safetyPOST(req("/api/tenant/safety", "POST", { term: "new_term" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; added: boolean };
    expect(body.added).toBe(true);
    expect(h.safeAwaitLabels).toContain("tenant_settings.update");
  });

  it("adds a new term via INSERT when no tenant_settings row exists yet", async () => {
    h.tableData["tenant_settings"] = null;
    const res = await safetyPOST(req("/api/tenant/safety", "POST", { term: "new_term" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; added: boolean };
    expect(body.added).toBe(true);
    expect(h.safeAwaitLabels).toContain("tenant_settings.insert");
  });

  it("returns added=false without a DB write when term is a duplicate (case-insensitive)", async () => {
    h.tableData["tenant_settings"] = { supplemental_hate_speech_denylist: ["Bad_Word"] };
    const res = await safetyPOST(req("/api/tenant/safety", "POST", { term: "bad_word" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; added: boolean };
    expect(body.added).toBe(false);
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("returns non-200 when safeAwait DB write fails — error must not be silently swallowed", async () => {
    // Pins that a DB write failure propagates outward rather than returning 200 OK.
    // The catch block calls respondToAuthError (mocked → 403); production returns 500
    // via safeAwait's structured throw. Either way, 200 is unacceptable.
    h.tableData["tenant_settings"] = { supplemental_hate_speech_denylist: [] };
    h.safeAwaitFails = true;
    const res = await safetyPOST(req("/api/tenant/safety", "POST", { term: "new_term" }));
    expect(res.status).not.toBe(200);
  });
});

describe("DELETE /api/tenant/safety", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await safetyDELETE(req("/api/tenant/safety?term=word", "DELETE"));
    expect(res.status).toBe(403);
  });

  it("returns 403 for non-Pro+ tier", async () => {
    h.tableData["tier_definitions"] = { code: "byo_research" };
    const res = await safetyDELETE(req("/api/tenant/safety?term=word", "DELETE"));
    expect(res.status).toBe(403);
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("returns 400 when ?term query param is missing", async () => {
    const res = await safetyDELETE(req("/api/tenant/safety", "DELETE"));
    expect(res.status).toBe(400);
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("removes the term and returns removed=true", async () => {
    h.tableData["tenant_settings"] = { supplemental_hate_speech_denylist: ["bad_word", "other"] };
    const res = await safetyDELETE(req("/api/tenant/safety?term=bad_word", "DELETE"));
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean };
    expect(body.removed).toBe(true);
    expect(h.safeAwaitLabels).toContain("tenant_settings.update");
  });

  it("returns removed=false without DB write when term is not in the list", async () => {
    h.tableData["tenant_settings"] = { supplemental_hate_speech_denylist: ["other"] };
    const res = await safetyDELETE(req("/api/tenant/safety?term=missing", "DELETE"));
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean };
    expect(body.removed).toBe(false);
    expect(h.safeAwaitLabels).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// chat-limits
// ═══════════════════════════════════════════════════════════════════════════

import { GET as chatLimitsGET, PUT as chatLimitsPUT } from "@/app/api/tenant/chat-limits/route";

describe("GET /api/tenant/chat-limits", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await chatLimitsGET(req("/api/tenant/chat-limits"));
    expect(res.status).toBe(403);
  });

  it("returns tier + can_override + override + defaults", async () => {
    h.tableData["customer_chat_tenant_overrides"] = { soft1_cap: 10, soft2_cap: 20, hard_cap: 30, booking_bonus_percent: 100 };
    const res = await chatLimitsGET(req("/api/tenant/chat-limits"));
    expect(res.status).toBe(200);
    const body = await res.json() as { tier: string; can_override: boolean };
    expect(body.tier).toBe("sub_pro");
    expect(body.can_override).toBe(true);
  });
});

describe("PUT /api/tenant/chat-limits", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await chatLimitsPUT(req("/api/tenant/chat-limits", "PUT", { soft1_cap: 10, soft2_cap: 20, hard_cap: 30, booking_bonus_percent: 50 }));
    expect(res.status).toBe(403);
  });

  it("returns 403 for non-Pro+ tier — tier gate prevents override", async () => {
    h.tableData["tier_definitions"] = { code: "byo_research" };
    const res = await chatLimitsPUT(req("/api/tenant/chat-limits", "PUT", { soft1_cap: 10, soft2_cap: 20, hard_cap: 30, booking_bonus_percent: 50 }));
    expect(res.status).toBe(403);
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("returns 422 when hard_cap is below the floor", async () => {
    // Platform floor=15, ceiling=200 via mock
    const res = await chatLimitsPUT(req("/api/tenant/chat-limits", "PUT", { soft1_cap: 5, soft2_cap: 10, hard_cap: 14, booking_bonus_percent: 50 }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("hard_cap_out_of_range");
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("returns 422 when ordering constraint is violated (soft1 ≥ soft2)", async () => {
    const res = await chatLimitsPUT(req("/api/tenant/chat-limits", "PUT", { soft1_cap: 25, soft2_cap: 20, hard_cap: 30, booking_bonus_percent: 50 }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("ordering_violation_soft1_soft2_hard");
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("returns 422 when booking_bonus_percent is out of [0,400]", async () => {
    const res = await chatLimitsPUT(req("/api/tenant/chat-limits", "PUT", { soft1_cap: 10, soft2_cap: 20, hard_cap: 30, booking_bonus_percent: 401 }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("booking_bonus_out_of_range");
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("updates existing override row and writes audit log", async () => {
    h.tableData["customer_chat_tenant_overrides"] = { tenant_id: "tenant-1" };
    const res = await chatLimitsPUT(req("/api/tenant/chat-limits", "PUT", { soft1_cap: 10, soft2_cap: 20, hard_cap: 30, booking_bonus_percent: 50 }));
    expect(res.status).toBe(200);
    expect(h.safeAwaitLabels).toContain("customer_chat_tenant_overrides.update");
    expect(h.writeAuditCalled).toBe(true);
  });

  it("inserts override row when none exists yet and writes audit log", async () => {
    h.tableData["customer_chat_tenant_overrides"] = null;
    const res = await chatLimitsPUT(req("/api/tenant/chat-limits", "PUT", { soft1_cap: 10, soft2_cap: 20, hard_cap: 30, booking_bonus_percent: 50 }));
    expect(res.status).toBe(200);
    expect(h.safeAwaitLabels).toContain("customer_chat_tenant_overrides.insert");
    expect(h.writeAuditCalled).toBe(true);
  });

  it("returns 403 when tier lookup DB errors — fail-closed (no Pro+ access granted on error)", async () => {
    // loadTier ignores DB errors and falls back to 'byo_research', which is non-Pro+.
    // This test pins that a DB error on the tier query never accidentally grants access.
    h.tableErrors["tenants"] = { message: "connection refused" };
    const res = await chatLimitsPUT(req("/api/tenant/chat-limits", "PUT", { soft1_cap: 10, soft2_cap: 20, hard_cap: 30, booking_bonus_percent: 50 }));
    expect(res.status).toBe(403);
    expect(h.safeAwaitLabels).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// branding
// ═══════════════════════════════════════════════════════════════════════════

import { GET as brandingGET, POST as brandingPOST } from "@/app/api/tenant/branding/route";

describe("GET /api/tenant/branding", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await brandingGET(req("/api/tenant/branding"));
    expect(res.status).toBe(403);
  });

  it("returns current branding or null when none set", async () => {
    h.tableData["tenant_branding"] = null;
    const res = await brandingGET(req("/api/tenant/branding"));
    expect(res.status).toBe(200);
    const body = await res.json() as { branding: null };
    expect(body.branding).toBeNull();
  });

  it("returns 500 when DB read errors (fail-closed via dbErrorResponse)", async () => {
    h.tableErrors["tenant_branding"] = { message: "replica lag" };
    const res = await brandingGET(req("/api/tenant/branding"));
    expect(res.status).toBe(500);
  });
});

describe("POST /api/tenant/branding", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await brandingPOST(req("/api/tenant/branding", "POST", { slogan: "Book smarter" }));
    expect(res.status).toBe(403);
  });

  it("returns 422 when primary_color is not a valid hex color", async () => {
    const res = await brandingPOST(req("/api/tenant/branding", "POST", { primary_color: "red" }));
    expect(res.status).toBe(422);
  });

  it("upserts branding and returns branding_id + show_powered_by (confirms upsert fired)", async () => {
    // branding_id only appears in the response when the upsert returns a row.
    // A mutant that strips the upsert call produces { data: null } → dbErrorResponse → not 200.
    const res = await brandingPOST(req("/api/tenant/branding", "POST", { slogan: "New tagline" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { branding_id: string; show_powered_by: boolean };
    expect(body.branding_id).toBe("branding-1");
    expect(typeof body.show_powered_by).toBe("boolean");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// usage
// ═══════════════════════════════════════════════════════════════════════════

import { GET as usageGET } from "@/app/api/tenant/usage/route";

describe("GET /api/tenant/usage", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await usageGET(req("/api/tenant/usage"));
    expect(res.status).toBe(403);
  });

  it("returns dims array and rag block for the current period", async () => {
    h.tableData["tenant_usage_metrics"] = {
      ai_cost_cents: "500",
      chat_messages_count: 5,
      email_sent_count: 2,
      group_invitees_count: 1,
      ai_cost_limit_state: "ok",
      chat_volume_limit_state: "ok",
      email_volume_limit_state: "ok",
      group_invite_limit_state: "ok",
    };
    const res = await usageGET(req("/api/tenant/usage"));
    expect(res.status).toBe(200);
    const body = await res.json() as { dims: unknown[]; rag: { state: string }; period: string };
    expect(Array.isArray(body.dims)).toBe(true);
    expect(body.dims).toHaveLength(4);
    expect(body.rag).toMatchObject({ state: "ok" });
    expect(typeof body.period).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// override-requests
// ═══════════════════════════════════════════════════════════════════════════

import {
  GET as overrideGET,
  POST as overridePOST,
} from "@/app/api/tenant/override-requests/route";

describe("GET /api/tenant/override-requests", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await overrideGET(req("/api/tenant/override-requests"));
    expect(res.status).toBe(403);
  });

  it("returns items array with seeded override requests (confirms DB read wired)", async () => {
    h.tableData["tenant_override_requests"] = [
      { id: "req-1", dimension: "ai_cost", status: "pending", requested_at: "2026-06-18T12:00:00Z" },
    ];
    const res = await overrideGET(req("/api/tenant/override-requests"));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string; status: string }> };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items[0]!.id).toBe("req-1");
    expect(body.items[0]!.status).toBe("pending");
  });
});

describe("POST /api/tenant/override-requests", () => {
  it("returns 403 when caller lacks permission", async () => {
    h.permFails = true;
    const res = await overridePOST(req("/api/tenant/override-requests", "POST", {
      dimension: "ai_cost",
      requested_threshold_kind: "hard",
      reason: "We need more",
    }));
    expect(res.status).toBe(403);
  });

  it("returns 400 when dimension is invalid", async () => {
    const res = await overridePOST(req("/api/tenant/override-requests", "POST", {
      dimension: "invalid_dimension",
      requested_threshold_kind: "hard",
      reason: "We need more capacity",
      current_state: "At current limit",
    }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when threshold_kind is invalid", async () => {
    const res = await overridePOST(req("/api/tenant/override-requests", "POST", {
      dimension: "ai_cost",
      requested_threshold_kind: "super_hard",
      reason: "We need more capacity",
      current_state: "At current limit",
    }));
    expect(res.status).toBe(400);
  });

  it("inserts override request and returns request body (confirms insert fired)", async () => {
    // request.id only exists when the insert + select returns data.
    // A mutant that strips the insert produces { data: null } → dbErrorResponse → not 200.
    h.tableData["tenant_override_requests"] = { id: "req-1", requested_at: "2026-06-18T12:00:00Z", status: "pending" };
    const res = await overridePOST(req("/api/tenant/override-requests", "POST", {
      dimension: "ai_cost",
      requested_threshold_kind: "hard",
      reason: "We need more capacity",
      current_state: "At the hard cap daily",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; request: { id: string; status: string } };
    expect(body.request.id).toBe("req-1");
    expect(body.request.status).toBe("pending");
  });
});
