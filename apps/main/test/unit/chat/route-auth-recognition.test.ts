// #860 — /api/chat must recognize the Supabase session COOKIE (not just a Bearer
// header), resolve the public.users.id (NOT the auth id) for the FK columns,
// route authenticated members through enforceCustomerLimit, bypass rate limiting
// for platform admins (costs still logged), and degrade an invalid session to
// anonymous instead of hard-erroring.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

// Shared, per-test-mutable config the service-role mock reads.
const h = vi.hoisted(() => ({ usersId: null as string | null, isAdmin: false }));

vi.mock("@/lib/env", () => ({ verifyEnvAtBoot: vi.fn() }));
// Table-aware fluent service-role mock: `users` → resolved public.users.id;
// `platform_admins` → admin membership; everything else → null / conv stub.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    const build = (table: string): Record<string, unknown> => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "insert", "update", "delete", "order", "limit", "in", "is", "gte", "lte", "neq", "not"]) {
        b[m] = () => b;
      }
      b.maybeSingle = async () => {
        if (table === "users") return { data: h.usersId ? { id: h.usersId } : null, error: null };
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
vi.mock("@/lib/supervisor/load-deny-list", () => ({ loadUnionSlurDenyList: vi.fn() }));
vi.mock("@/lib/ai/call-wrapper", () => ({ instrumentedClaudeCall: vi.fn() }));
vi.mock("@/lib/ai/stream-wrapper", () => ({ instrumentedClaudeStream: vi.fn() }));
vi.mock("@/lib/ai/sentence-buffer", () => ({ bufferToSentences: vi.fn() }));
vi.mock("@/lib/supervisor/per-sentence-check", () => ({ checkSentence: vi.fn() }));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/vendor-health/registry", () => ({ vendorHealthStatus: vi.fn() }));
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
vi.mock("@/lib/abuse/snapshot", () => ({ loadTenantSnapshot: vi.fn() }));
vi.mock("@/lib/abuse/counters", () => ({ incrementChatMessages: vi.fn() }));
vi.mock("@/lib/supervisor/run-supervisor", () => ({ runSupervisor: vi.fn(), HATE_SPEECH_REGEN_INSTRUCTION: "" }));
vi.mock("@/lib/chat/customer-tone-override", () => ({ detectToneOverride: vi.fn(), applyToneOverride: vi.fn() }));
vi.mock("@/lib/chat/tone-resolution", () => ({ resolveToneLevel: vi.fn() }));
vi.mock("@/lib/chat/fingerprint", () => ({ deriveFingerprint: vi.fn(), extractClientIp: vi.fn() }));
vi.mock("@/lib/db/safe-mutation", () => ({ safeAwait: vi.fn() }));

import { POST } from "@/app/api/chat/route";
import { retrieveForChat } from "@/lib/rag/retrieve-for-chat";
import { tenantContextFromRequest } from "@/lib/db/factories";
import { enforceCustomerLimit } from "@/lib/chat/customer-limit";
import { enforceAnonLimit } from "@/lib/chat/anonymous-limit";
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
const ANON_ID = "anon-sess-00000000-0000-0000-0000-0000000000aa";

beforeEach(() => {
  vi.clearAllMocks();
  h.usersId = "users-1";
  h.isAdmin = false;
  vi.mocked(verifyAnonSession).mockReturnValue(null);
  vi.mocked(freshAnonSession).mockReturnValue({ id: ANON_ID, cookieValue: "cv" });
  vi.mocked(tenantContextFromRequest).mockResolvedValue({
    tenant_id: "tenant-1",
    source: { kind: "http_request", user_id: "auth-1" },
  } as never);
  vi.mocked(enforceCustomerLimit).mockResolvedValue({
    tier: "below", current_count: 1,
    resolved: { soft1_cap: 20, soft2_cap: 30, hard_cap: 40, booking_bonus_percent: 0 },
  } as never);
  vi.mocked(enforceAnonLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(detectBugIntent).mockResolvedValue({ triggered: false } as never);
  vi.mocked(loadConversationHistory).mockResolvedValue([] as never);
  vi.mocked(resolveActivePersonaSlug).mockResolvedValue("marcus-cole");
  vi.mocked(buildSystemPrompt).mockResolvedValue({ prompt: "system", citations: [] } as never);
  vi.mocked(retrieveForChat).mockResolvedValue({
    knowledge_block: "", citations: [], retrieved_chunk_ids: [],
    entities: EMPTY_ENTITIES, retrieval_id: null, retrieval_latency_ms: null, assets: [],
  });
});

// Cookie-authenticated request (sb-*-auth-token present, no Bearer).
function cookieAuthedReq(): Request {
  return new Request("https://booking.example.com/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "sb-test-auth-token=abc",
      [RESOLVED_TENANT_ID_HEADER]: "tenant-1",
    },
    body: JSON.stringify({ message: "what's the itinerary" }),
  });
}

describe("POST /api/chat — cookie auth recognition + staff bypass (#860)", () => {
  it("authenticated member: resolves public.users.id (not the auth id) and routes through enforceCustomerLimit", async () => {
    const res = await POST(cookieAuthedReq());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(retrieveForChat).toHaveBeenCalled());
    // user_id is the public.users.id — NOT the auth id ("auth-1") and NOT an anon session.
    expect(vi.mocked(retrieveForChat).mock.calls[0]![0].user_id).toBe("users-1");
    await vi.waitFor(() => expect(enforceCustomerLimit).toHaveBeenCalled());
    expect(vi.mocked(enforceCustomerLimit).mock.calls[0]![1]).toMatchObject({ user_id: "users-1", tenant_id: "tenant-1" });
    expect(enforceAnonLimit).not.toHaveBeenCalled();
  });

  it("platform admin: bypasses BOTH rate limiters but still attributes to users.id (costs logged)", async () => {
    h.isAdmin = true;
    const res = await POST(cookieAuthedReq());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(retrieveForChat).toHaveBeenCalled());
    expect(vi.mocked(retrieveForChat).mock.calls[0]![0].user_id).toBe("users-1");
    expect(enforceCustomerLimit).not.toHaveBeenCalled();
    expect(enforceAnonLimit).not.toHaveBeenCalled();
  });

  it("invalid/expired session: degrades to anonymous (user_id null, anon limiter) — no hard error", async () => {
    vi.mocked(tenantContextFromRequest).mockRejectedValue(new Error("invalid or expired access token"));
    const res = await POST(cookieAuthedReq());
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(retrieveForChat).toHaveBeenCalled());
    expect(vi.mocked(retrieveForChat).mock.calls[0]![0].user_id).toBeNull();
    expect(enforceAnonLimit).toHaveBeenCalled();
    expect(enforceCustomerLimit).not.toHaveBeenCalled();
  });
});
