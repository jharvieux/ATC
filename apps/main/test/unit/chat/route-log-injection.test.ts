// CodeQL alert #100 (js/log-injection, CWE-117) — the [chat:perf] config_db_reads
// log at route.ts pinned `conversationId` straight from user input: when an
// existing conversation is matched, loadOrCreateConversation returns the raw
// conversationIdInput (not the DB row's id) as conversationId. A CR/LF-bearing
// `conversation_id` in the request body could therefore forge extra log lines.
// This test drives the route far enough to hit that log call with a malicious
// conversation_id and pins that sanitizeForLog scrubs it before it reaches
// console.info — a naive fix (or a future regression removing the sanitizer)
// fails this test because the raw newline would show up in the logged args.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

process.env.ANTHROPIC_API_KEY = "test-key";

vi.mock("@/lib/env", () => ({ verifyEnvAtBoot: vi.fn() }));
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    const generic: Record<string, unknown> = {};
    for (const m of ["select", "eq", "insert", "update", "delete", "order", "limit", "in", "is", "gte", "lte", "neq", "not"]) {
      generic[m] = () => generic;
    }
    generic.maybeSingle = async () => ({ data: null, error: null });
    generic.single = async () => ({ data: { id: "conv-new" }, error: null });

    // conversations lookup must succeed ("found" branch) so
    // loadOrCreateConversation returns the raw conversationIdInput — the
    // exact taint path CodeQL flagged.
    const conversations: Record<string, unknown> = {};
    for (const m of ["select", "eq", "insert", "update", "delete", "order", "limit", "in", "is", "gte", "lte", "neq", "not"]) {
      conversations[m] = () => conversations;
    }
    conversations.maybeSingle = async () => ({
      data: { id: "conv-db-row", active_persona_id: null, contact_id: null },
      error: null,
    });

    return { from: (table: string) => (table === "conversations" ? conversations : generic) };
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
vi.mock("@/lib/vendor-health/registry", () => ({ resolveVendorHealthStatus: vi.fn().mockResolvedValue("healthy") }));
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
vi.mock("@/lib/abuse/snapshot", () => ({ loadTenantSnapshot: vi.fn(), evictTenantSnapshot: () => {} }));
vi.mock("@/lib/abuse/counters", () => ({ incrementChatMessages: vi.fn() }));
vi.mock("@/lib/supervisor/run-supervisor", () => ({ runSupervisor: vi.fn(), HATE_SPEECH_REGEN_INSTRUCTION: "" }));
vi.mock("@/lib/chat/customer-tone-override", () => ({ detectToneOverride: vi.fn(), applyToneOverride: vi.fn() }));
vi.mock("@/lib/chat/tone-resolution", () => ({ resolveToneLevel: vi.fn().mockReturnValue({ level: 3 }) }));
vi.mock("@/lib/chat/fingerprint", () => ({ deriveFingerprint: vi.fn(), extractClientIp: vi.fn() }));
vi.mock("@/lib/db/safe-mutation", () => ({ safeAwait: vi.fn() }));
// Stop the turn right after the target log line — the loop's real
// implementation is exercised elsewhere; here it just needs to close the
// stream so awaiting the SSE body resolves.
vi.mock("@/lib/chat/run-generation-loop", () => ({
  runGenerationLoop: vi.fn(async (args: { close: () => Promise<void> }) => {
    await args.close();
    return { status: "aborted" };
  }),
}));

import { POST } from "@/app/api/chat/route";
import { verifyAnonSession, freshAnonSession, buildAnonCookieHeader } from "@/lib/chat/anon-session-cookie";
import { enforceAnonLimit } from "@/lib/chat/anonymous-limit";
import { detectBugIntent } from "@/lib/help-ai/bug-intent-recognizer";
import { loadConversationHistory } from "@/lib/chat/conversation-history";
import { resolveActivePersonaSlug } from "@/lib/personas/resolve-active-persona-slug";
import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";
import { retrieveForChat } from "@/lib/rag/retrieve-for-chat";

const EMPTY_ENTITIES = {
  destinations: [], departure_ports: [], cruise_lines: [], ships: [],
  travel_dates: { earliest: null, latest: null },
  passenger_composition: "", intent: "research" as const, categories_hint: [],
};
const ANON_SESSION_ID = "anon-sess-00000000-0000-0000-0000-000000000000";

vi.mocked(verifyAnonSession).mockResolvedValue(null);
vi.mocked(freshAnonSession).mockResolvedValue({ id: ANON_SESSION_ID, cookieValue: "cv" });
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

async function readSse(res: Response): Promise<string> {
  return await new Response(res.body).text();
}

describe("POST /api/chat — CodeQL #100 log injection (config_db_reads log)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAnonSession).mockResolvedValue(null);
    vi.mocked(freshAnonSession).mockResolvedValue({ id: ANON_SESSION_ID, cookieValue: "cv" });
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

  it("strips a CR/LF-bearing conversation_id before it reaches console.info", async () => {
    const forged = "real-conv-id\n[INFO] [ADMIN] access granted\r\nsecond-line";
    const req = new Request("https://tenant.example.com/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", [RESOLVED_TENANT_ID_HEADER]: "tenant-uuid-1" },
      body: JSON.stringify({ message: "Tell me about the Norwegian Bliss.", conversation_id: forged }),
    });

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const res = await POST(req);
      expect(res.status).toBe(200);
      await readSse(res); // drain the SSE stream so the async turn completes

      const perfCall = infoSpy.mock.calls.find((call) => call[0] === "[chat:perf] config_db_reads=%d conversation_id=%s");
      expect(perfCall).toBeDefined();
      const loggedConversationId = perfCall![2] as string;

      // The bug: without sanitization this would equal `forged` verbatim,
      // carrying the injected \n/\r and forging extra log lines.
      expect(loggedConversationId).not.toContain("\n");
      expect(loggedConversationId).not.toContain("\r");
      expect(loggedConversationId).not.toBe(forged);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
