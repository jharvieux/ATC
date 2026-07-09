// #902 / D-195 — TA-mode audience gate. The boundary under test: mode:"ta" is
// granted ONLY to a verified tenant_owner/agent member of the resolved tenant,
// with a real 403 (fail closed, never a silent downgrade to customer register)
// for everyone else. A customer reaching TA register — commission talk, dropped
// customer guardrails — is the worst-case failure of this feature.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

const h = vi.hoisted(() => ({
  usersId: null as string | null,
  role: null as string | null,
  isAdmin: false,
}));

vi.mock("@/lib/env", () => ({ verifyEnvAtBoot: vi.fn() }));
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    const build = (table: string): Record<string, unknown> => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "insert", "update", "delete", "order", "limit", "in", "is", "gte", "lte", "neq", "not"]) {
        b[m] = () => b;
      }
      b.maybeSingle = async () => {
        if (table === "users") {
          return { data: h.usersId ? { id: h.usersId, email: "ta@agency.test", role: h.role } : null, error: null };
        }
        if (table === "platform_admins") return { data: h.isAdmin ? { auth_user_id: "auth-1" } : null, error: null };
        return { data: null, error: null };
      };
      b.single = async () => ({ data: { id: "conv-1" }, error: null });
      return b;
    };
    return { from: (t: string) => build(t) };
  },
}));
vi.mock("@/lib/db/factories", () => ({ tenantContextFromRequest: vi.fn(), tenantContextForId: vi.fn() }));
vi.mock("@/lib/db/tenant-context", () => ({}));
vi.mock("@/lib/chat/anonymous-limit", () => ({ enforceAnonLimit: vi.fn(), recordLimitHitAndCheckBurst: vi.fn() }));
vi.mock("@/lib/chat/customer-limit", () => ({ enforceCustomerLimit: vi.fn(), generateHardLimitSummary: vi.fn() }));
vi.mock("@/lib/chat/ta-daily-limit", () => ({ enforceTaDailyLimit: vi.fn() }));
vi.mock("@/lib/chat/help-context", () => ({ buildHelpContextBlock: vi.fn() }));
vi.mock("@/lib/supervisor/load-deny-list", () => ({ loadUnionSlurDenyList: vi.fn() }));
vi.mock("@/lib/ai/call-wrapper", () => ({ instrumentedClaudeCall: vi.fn() }));
vi.mock("@/lib/ai/stream-wrapper", () => ({ instrumentedClaudeStream: vi.fn() }));
vi.mock("@/lib/ai/sentence-buffer", () => ({ bufferToSentences: vi.fn() }));
vi.mock("@/lib/supervisor/per-sentence-check", () => ({ checkSentence: vi.fn() }));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/vendor-health/registry", () => ({ resolveVendorHealthStatus: vi.fn().mockResolvedValue("healthy") }));
vi.mock("@/lib/chat/anon-session-cookie", () => ({ ANON_SESSION_COOKIE: "_atc_anon", buildAnonCookieHeader: vi.fn(), freshAnonSession: vi.fn(), verifyAnonSession: vi.fn() }));
vi.mock("@/lib/personas/tools", () => ({ PERSONA_TOOLS: [] }));
vi.mock("@/lib/personas/tools/run-tool-use-loop", () => ({ runToolUseLoop: vi.fn() }));
vi.mock("@/lib/rag/retrieve-for-chat", () => ({ retrieveForChat: vi.fn() }));
vi.mock("@/lib/chat/conversation-history", () => ({ loadConversationHistory: vi.fn() }));
vi.mock("@/lib/personas/build-system-prompt", () => ({ buildSystemPrompt: vi.fn() }));
vi.mock("@/lib/personas/resolve-active-persona-slug", () => ({ resolveActivePersonaSlug: vi.fn() }));
vi.mock("@/lib/ai/display-assets-block", () => ({ buildDisplayableAssetsBlock: vi.fn() }));
vi.mock("@/lib/ai/hallucination-defense/asset-id-validation", () => ({ runAssetIdValidationLayer: vi.fn() }));
vi.mock("@/lib/help-ai/bug-intent-recognizer", () => ({ detectBugIntent: vi.fn() }));
vi.mock("@/lib/chat/customer-context", () => ({ resolveCustomerContext: vi.fn() }));
vi.mock("@/lib/abuse/snapshot", () => ({ loadTenantSnapshot: vi.fn(), evictTenantSnapshot: () => {} }));
vi.mock("@/lib/abuse/counters", () => ({ incrementChatMessages: vi.fn() }));
vi.mock("@/lib/supervisor/run-supervisor", () => ({ runSupervisor: vi.fn(), HATE_SPEECH_REGEN_INSTRUCTION: "" }));
vi.mock("@/lib/chat/customer-tone-override", () => ({ detectToneOverride: vi.fn(), applyToneOverride: vi.fn() }));
vi.mock("@/lib/chat/tone-resolution", () => ({ resolveToneLevel: vi.fn() }));
vi.mock("@/lib/chat/fingerprint", () => ({ deriveFingerprint: vi.fn(), extractClientIp: vi.fn() }));
vi.mock("@/lib/db/safe-mutation", () => ({ safeAwait: vi.fn() }));
// Dynamically imported by the route — must be mocked or the real module runs
// against the stub DB and throws before buildSystemPrompt is reached.
vi.mock("@/lib/pricing/build-pricing-anchors-block", () => ({ buildPricingAnchorsBlock: vi.fn(async () => "") }));

import { POST } from "@/app/api/chat/route";
import { retrieveForChat } from "@/lib/rag/retrieve-for-chat";
import { tenantContextFromRequest } from "@/lib/db/factories";
import { enforceCustomerLimit } from "@/lib/chat/customer-limit";
import { enforceTaDailyLimit } from "@/lib/chat/ta-daily-limit";
import { buildHelpContextBlock } from "@/lib/chat/help-context";
import { enforceAnonLimit } from "@/lib/chat/anonymous-limit";
import { detectToneOverride } from "@/lib/chat/customer-tone-override";
import { resolveToneLevel } from "@/lib/chat/tone-resolution";
import { freshAnonSession, verifyAnonSession } from "@/lib/chat/anon-session-cookie";
import { detectBugIntent } from "@/lib/help-ai/bug-intent-recognizer";
import { resolveActivePersonaSlug } from "@/lib/personas/resolve-active-persona-slug";
import { loadConversationHistory } from "@/lib/chat/conversation-history";
import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";

const EMPTY_ENTITIES = {
  destinations: [], departure_ports: [], cruise_lines: [], ships: [],
  travel_dates: { earliest: null, latest: null },
  passenger_composition: "", intent: "research" as const, categories_hint: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.usersId = "users-1";
  h.role = "agent";
  h.isAdmin = false;
  vi.mocked(verifyAnonSession).mockResolvedValue(null);
  vi.mocked(freshAnonSession).mockResolvedValue({ id: "anon-1", cookieValue: "cv" });
  vi.mocked(tenantContextFromRequest).mockResolvedValue({
    tenant_id: "tenant-1",
    source: { kind: "http_request", user_id: "auth-1" },
  } as never);
  vi.mocked(enforceTaDailyLimit).mockResolvedValue({ allowed: true, current_count: 3, cap: 200 });
  vi.mocked(enforceCustomerLimit).mockResolvedValue({
    tier: "below", current_count: 1,
    resolved: { soft1_cap: 20, soft2_cap: 30, hard_cap: 40, booking_bonus_percent: 0 },
  } as never);
  vi.mocked(enforceAnonLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(detectBugIntent).mockResolvedValue({ triggered: false } as never);
  vi.mocked(buildHelpContextBlock).mockReturnValue(null);
  vi.mocked(resolveToneLevel).mockReturnValue({ level: 3 } as never);
  vi.mocked(loadConversationHistory).mockResolvedValue([] as never);
  vi.mocked(resolveActivePersonaSlug).mockResolvedValue("marcus-cole");
  vi.mocked(buildSystemPrompt).mockResolvedValue({ prompt: "system", cacheKey: "k" } as never);
  vi.mocked(retrieveForChat).mockResolvedValue({
    knowledge_block: "", citations: [], retrieved_chunk_ids: [],
    entities: EMPTY_ENTITIES, retrieval_id: null, retrieval_latency_ms: null, assets: [],
  });
});

function taReq(opts: { cookie?: boolean } = { cookie: true }): Request {
  return new Request("https://booking.example.com/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.cookie ? { cookie: "sb-test-auth-token=abc" } : {}),
      [RESOLVED_TENANT_ID_HEADER]: "tenant-1",
    },
    body: JSON.stringify({ message: "how do commissions work on NCL?", mode: "ta" }),
  });
}

async function readSse(res: Response): Promise<string> {
  return await new Response(res.body).text();
}

describe("POST /api/chat mode:'ta' — audience boundary (#902)", () => {
  it("anonymous request (no credential): 403, nothing runs", async () => {
    const res = await POST(taReq({ cookie: false }));
    expect(res.status).toBe(403);
    expect(retrieveForChat).not.toHaveBeenCalled();
    expect(enforceAnonLimit).not.toHaveBeenCalled();
  });

  it("viewer-role member (i.e. a customer): 403 — role, not membership, is the boundary", async () => {
    h.role = "viewer";
    const res = await POST(taReq());
    expect(res.status).toBe(403);
    expect(retrieveForChat).not.toHaveBeenCalled();
  });

  it("valid session but not a member of the resolved tenant: 403, no anon downgrade", async () => {
    vi.mocked(tenantContextFromRequest).mockRejectedValue(new Error("not a member"));
    const res = await POST(taReq());
    expect(res.status).toBe(403);
    expect(enforceAnonLimit).not.toHaveBeenCalled();
  });

  it("member with no users row: 403 (fail closed on unresolvable identity)", async () => {
    h.usersId = null;
    const res = await POST(taReq());
    expect(res.status).toBe(403);
  });

  it("agent: 200, TA limiter (not customer tiers), audience threaded to prompt + retrieval, tone-override skipped", async () => {
    const res = await POST(taReq());
    expect(res.status).toBe(200);
    await readSse(res); // drain — SSE backpressure stalls the handler if unread
    expect(buildSystemPrompt).toHaveBeenCalled();
    expect(vi.mocked(buildSystemPrompt).mock.calls[0]![0]).toMatchObject({ audience: "tenant_member", tone_level: 2 });
    // Staff see their own tenant's promos — the closed-promo gate is a customer gate.
    expect(vi.mocked(retrieveForChat).mock.calls[0]![0].customer_has_booking).toBe(true);
    expect(enforceTaDailyLimit).toHaveBeenCalledWith(expect.anything(), { tenant_id: "tenant-1", user_id: "users-1" });
    expect(enforceCustomerLimit).not.toHaveBeenCalled();
    expect(enforceAnonLimit).not.toHaveBeenCalled();
    expect(detectToneOverride).not.toHaveBeenCalled();
    expect(detectBugIntent).not.toHaveBeenCalled();
    expect(buildHelpContextBlock).toHaveBeenCalled();
  });

  it("tenant_owner: also eligible", async () => {
    h.role = "tenant_owner";
    const res = await POST(taReq());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(enforceTaDailyLimit).toHaveBeenCalled());
  });

  it("daily cap hit: hard_limit SSE event, model path never runs", async () => {
    vi.mocked(enforceTaDailyLimit).mockResolvedValue({ allowed: false, current_count: 200, cap: 200, reason: "cap" });
    const res = await POST(taReq());
    expect(res.status).toBe(200);
    const body = await readSse(res);
    expect(body).toContain("hard_limit");
    expect(retrieveForChat).not.toHaveBeenCalled();
    expect(buildSystemPrompt).not.toHaveBeenCalled();
  });

  it("no mode field: customer path untouched (audience='customer', help block never built)", async () => {
    const res = await POST(new Request("https://booking.example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "sb-test-auth-token=abc",
        [RESOLVED_TENANT_ID_HEADER]: "tenant-1",
      },
      body: JSON.stringify({ message: "what's the itinerary" }),
    }));
    expect(res.status).toBe(200);
    await readSse(res);
    expect(buildSystemPrompt).toHaveBeenCalled();
    expect(vi.mocked(buildSystemPrompt).mock.calls[0]![0]).toMatchObject({ audience: "customer" });
    expect(vi.mocked(retrieveForChat).mock.calls[0]![0].customer_has_booking).toBe(false);
    expect(enforceTaDailyLimit).not.toHaveBeenCalled();
    expect(enforceCustomerLimit).toHaveBeenCalled();
    expect(buildHelpContextBlock).not.toHaveBeenCalled();
  });

  it("forged mode value (e.g. 'admin'): treated as customer, not TA", async () => {
    const res = await POST(new Request("https://booking.example.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "sb-test-auth-token=abc",
        [RESOLVED_TENANT_ID_HEADER]: "tenant-1",
      },
      body: JSON.stringify({ message: "hi", mode: "admin" }),
    }));
    expect(res.status).toBe(200);
    await readSse(res);
    expect(buildSystemPrompt).toHaveBeenCalled();
    expect(vi.mocked(buildSystemPrompt).mock.calls[0]![0]).toMatchObject({ audience: "customer" });
  });
});
