// §24 — Chat route: message-length cap (S5852 ReDoS guard).
//
// The PASSPORT_CONTEXT_BEFORE regex in pii/redact.ts contains \s*[:#-]?\s*
// which is O(n^2) on long runs of spaces. Without this cap an attacker can
// POST `passport` followed by thousands of spaces and stall the handler.
// This test pins the intent: the cap must reject before redactPii() is called.

import { describe, it, expect, vi } from "vitest";

// Mock heavy imports — the test exercises the early-return path before any
// of these are used. We mock them so the module loads cleanly without
// real DB/Redis/API connections.
vi.mock("@/lib/env", () => ({ verifyEnvAtBoot: vi.fn() }));
vi.mock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/db/factories", () => ({ tenantContextFromRequest: vi.fn(), tenantContextForId: vi.fn() }));
vi.mock("@/lib/db/tenant-context", () => ({}));
vi.mock("@/lib/chat/anonymous-limit", () => ({
  enforceAnonLimit: vi.fn(),
  recordLimitHitAndCheckBurst: vi.fn(),
}));
vi.mock("@/lib/chat/customer-limit", () => ({
  enforceCustomerLimit: vi.fn(),
  generateHardLimitSummary: vi.fn(),
}));
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
vi.mock("@/lib/supervisor/run-supervisor", () => ({
  runSupervisor: vi.fn(),
  HATE_SPEECH_REGEN_INSTRUCTION: "",
}));
vi.mock("@/lib/chat/customer-tone-override", () => ({
  detectToneOverride: vi.fn(),
  applyToneOverride: vi.fn(),
}));
vi.mock("@/lib/chat/tone-resolution", () => ({ resolveToneLevel: vi.fn() }));
vi.mock("@/lib/chat/fingerprint", () => ({ deriveFingerprint: vi.fn(), extractClientIp: vi.fn() }));
vi.mock("@/lib/db/safe-mutation", () => ({ safeAwait: vi.fn() }));

import { POST } from "@/app/api/chat/route";

function chatReq(message: string): Request {
  return new Request("https://tenant.example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

describe("POST /api/chat — message length cap", () => {
  it("rejects messages over 8000 chars with message_too_long (S5852 ReDoS guard)", async () => {
    // Without this cap, `passport` followed by thousands of spaces would cause
    // PASSPORT_CONTEXT_BEFORE (\s*[:#-]?\s*) to backtrack polynomially. Use
    // non-whitespace chars so .trim() doesn't strip the length below the cap.
    const longMessage = "a".repeat(8001);
    const res = await POST(chatReq(longMessage));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("message_too_long");
  });

  it("does NOT trigger message_too_long for messages at exactly 8000 chars", async () => {
    // Boundary: 8000 chars is ≤ 8000, so the cap must not fire.
    // The request then fails at tenant resolution (no header in unit test) — that
    // is expected and distinct from the length-cap path.
    const exactMessage = "a".repeat(8000);
    const res = await POST(chatReq(exactMessage));
    const body = await res.json() as { error: string };
    expect(body.error).not.toBe("message_too_long");
  });
});
