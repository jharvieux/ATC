// #850 — On an ANONYMOUS chat turn, the route must pass `user_id: null` (NOT the
// anon session id) into retrieveForChat. ai_call_log.user_id has an FK to
// users(id), and entity extraction writes that row mid-retrieval via
// instrumentedClaudeCall. The pre-fix code passed `userId ?? anonSessionId ??
// "anonymous"`, so every anonymous turn FK-violated the ai_call_log insert →
// extraction threw → empty entities → the concierge ignored ship+date itinerary
// data. This test fails if that conflation is ever reintroduced.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

vi.mock("@/lib/env", () => ({ verifyEnvAtBoot: vi.fn() }));
// Self-contained fluent service-role mock: every builder method chains, and the
// terminal reads resolve enough for handleChat to reach retrieveForChat.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "insert", "update", "delete", "order", "limit", "in", "is", "gte", "lte", "neq", "not"]) {
      b[m] = () => b;
    }
    b.maybeSingle = async () => ({ data: null, error: null });
    b.single = async () => ({ data: { id: "conv-1" }, error: null });
    return { from: () => b };
  },
}));
vi.mock("@/lib/db/factories", () => ({ tenantContextFromRequest: vi.fn(), tenantContextForId: vi.fn() }));
vi.mock("@/lib/db/tenant-context", () => ({}));
vi.mock("@/lib/chat/anonymous-limit", () => ({
  enforceAnonLimit: vi.fn(),
  recordLimitHitAndCheckBurst: vi.fn(),
}));
vi.mock("@/lib/chat/customer-limit", () => ({ enforceCustomerLimit: vi.fn(), generateHardLimitSummary: vi.fn() }));
vi.mock("@/lib/supervisor/load-deny-list", () => ({ loadUnionSlurDenyList: vi.fn() }));
vi.mock("@/lib/ai/call-wrapper", () => ({ instrumentedClaudeCall: vi.fn() }));
vi.mock("@/lib/ai/stream-wrapper", () => ({ instrumentedClaudeStream: vi.fn() }));
vi.mock("@/lib/ai/sentence-buffer", () => ({ bufferToSentences: vi.fn() }));
vi.mock("@/lib/supervisor/per-sentence-check", () => ({ checkSentence: vi.fn() }));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/lib/vendor-health/registry", () => ({ vendorHealthStatus: vi.fn() }));
vi.mock("@/lib/chat/anon-session-cookie", () => ({
  ANON_SESSION_COOKIE: "_atc_anon",
  buildAnonCookieHeader: vi.fn(),
  freshAnonSession: vi.fn(),
  verifyAnonSession: vi.fn(),
}));
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
import { enforceAnonLimit } from "@/lib/chat/anonymous-limit";
import { freshAnonSession, verifyAnonSession, buildAnonCookieHeader } from "@/lib/chat/anon-session-cookie";
import { detectBugIntent } from "@/lib/help-ai/bug-intent-recognizer";
import { resolveActivePersonaSlug } from "@/lib/personas/resolve-active-persona-slug";
import { loadConversationHistory } from "@/lib/chat/conversation-history";
import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";

const EMPTY_ENTITIES = {
  destinations: [], departure_ports: [], cruise_lines: [], ships: [],
  travel_dates: { earliest: null, latest: null },
  passenger_composition: "", intent: "research" as const, categories_hint: [],
};

const ANON_SESSION_ID = "anon-sess-00000000-0000-0000-0000-000000000000";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyAnonSession).mockReturnValue(null);
  vi.mocked(freshAnonSession).mockReturnValue({ id: ANON_SESSION_ID, cookieValue: "cv" });
  vi.mocked(buildAnonCookieHeader).mockReturnValue("_atc_anon=cv");
  vi.mocked(enforceAnonLimit).mockResolvedValue({ allowed: true });
  vi.mocked(detectBugIntent).mockResolvedValue({ triggered: false } as never);
  vi.mocked(loadConversationHistory).mockResolvedValue([] as never);
  vi.mocked(resolveActivePersonaSlug).mockResolvedValue("marcus-cole");
  vi.mocked(buildSystemPrompt).mockResolvedValue({ prompt: "system", citations: [] } as never);
  vi.mocked(retrieveForChat).mockResolvedValue({
    knowledge_block: "", citations: [], retrieved_chunk_ids: [],
    entities: EMPTY_ENTITIES, retrieval_id: null, retrieval_latency_ms: null, assets: [],
  });
});

function anonReq(message: string): Request {
  return new Request("https://booking.example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", [RESOLVED_TENANT_ID_HEADER]: "tenant-uuid-1" },
    body: JSON.stringify({ message }),
  });
}

describe("POST /api/chat — anonymous user_id attribution (#850)", () => {
  it("passes user_id=null into retrieveForChat for an anonymous turn (never the anon session id)", async () => {
    const res = await POST(anonReq("What is the itinerary for the Norwegian Bliss on 10/3/26?"));
    expect(res.status).toBe(200);

    // handleChat runs detached from the Response; wait for it to reach retrieval.
    await vi.waitFor(() => expect(retrieveForChat).toHaveBeenCalled());

    const arg = vi.mocked(retrieveForChat).mock.calls[0]![0];
    // The FK-safe contract: real users.id or null — and for anon it's null.
    expect(arg.user_id).toBeNull();
    // Explicit regression guard against `userId ?? anonSessionId ?? "anonymous"`.
    expect(arg.user_id).not.toBe(ANON_SESSION_ID);
    expect(arg.user_id).not.toBe("anonymous");
  });
});
