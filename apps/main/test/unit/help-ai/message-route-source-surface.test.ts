// #1823 — the help-AI message route threads help_sessions.source_surface into
// bugQuestionForState so customer_chat sessions get the §32.10.3 friendly copy
// and admin sessions get the tenant-admin defaults. The unit test in
// flow-controller.test.ts proves the selector; this proves the ROUTE actually
// passes the column through end-to-end. Intent: a wiring regression (dropping
// source_surface, hardcoding a surface) fails here even if the selector stays
// correct. We assert on the system prompt handed to the LLM, since the next
// question is appended verbatim as the flow addendum.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sourceSurface: "customer_chat" as "admin" | "customer_chat",
  capturedSystem: "" as string,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "t-1", source: { kind: "http_request", user_id: "u-1" } },
    user: { id: "u-1" },
  })),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 401 })),
}));
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "insert", "update", "order", "in", "limit"]) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = async () => {
        if (table === "help_sessions") {
          return {
            data: {
              id: "s-1",
              session_type: "bug",
              source_surface: h.sourceSurface,
              conversation_id: "conv-1",
            },
            error: null,
          };
        }
        if (table === "platform_settings") return { data: { value: false }, error: null };
        if (table === "tenants") return { data: { ai_paused_by_platform: false }, error: null };
        return { data: null, error: null };
      };
      chain.single = async () => ({ data: { id: "conv-1" }, error: null });
      return chain;
    },
  }),
}));
vi.mock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/lib/db/safe-mutation", () => ({ safeAwait: vi.fn(async () => ({ data: null, error: null })) }));
vi.mock("@/lib/chat/conversation-history", () => ({ loadConversationHistory: vi.fn(async () => []) }));
vi.mock("@/lib/chat/help-context", () => ({ buildHelpContextBlock: vi.fn(() => "") }));
vi.mock("@/lib/personas/build-system-prompt", () => ({
  buildSystemPrompt: vi.fn(async () => ({ prompt: "SYSTEM_PROMPT_BASE" })),
}));
vi.mock("@/lib/abuse/snapshot", () => ({ loadTenantSnapshot: vi.fn(async () => ({ tenant: {} })) }));
vi.mock("@/lib/abuse/counters", () => ({ incrementChatMessages: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: () => ({ ANTHROPIC_SONNET_MODEL: "claude-test" }) }));
vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: vi.fn(async (args: { system: string }) => {
    h.capturedSystem = args.system;
    return { text: "assistant reply" };
  }),
}));
// Streaming path is off by default (HELP_AI_STREAMING_ENABLED unset); mock the
// stream deps so the module import resolves.
vi.mock("@/lib/ai/stream-wrapper", () => ({ instrumentedClaudeStream: vi.fn() }));
vi.mock("@/lib/ai/sentence-buffer", () => ({ bufferToSentences: vi.fn() }));
vi.mock("@/lib/supervisor/load-deny-list", () => ({ loadUnionSlurDenyList: vi.fn() }));
vi.mock("@/lib/supervisor/per-sentence-check", () => ({ checkSentence: vi.fn() }));

import { POST } from "@/app/api/help/sessions/[id]/message/route";

function call() {
  const req = new Request("https://t.example.com/api/help/sessions/s-1/message", {
    method: "POST",
    body: JSON.stringify({ message: "The map is blank" }),
  });
  return POST(req, { params: Promise.resolve({ id: "s-1" }) });
}

// Customer copy for the state after answering gathering_location (→ gathering_actual).
const CUSTOMER_Q = "What happened?";
// Admin default for the same state.
const ADMIN_Q = "What is it doing? Describe what you actually saw";

beforeEach(() => {
  vi.clearAllMocks();
  h.capturedSystem = "";
});

describe("POST /api/help/sessions/[id]/message — source_surface threading (#1823)", () => {
  it("customer_chat session gets the friendly customer copy in the flow addendum", async () => {
    h.sourceSurface = "customer_chat";
    const res = await call();
    await res.text(); // drain the SSE stream so the async worker completes
    expect(h.capturedSystem).toContain(CUSTOMER_Q);
    expect(h.capturedSystem).not.toContain(ADMIN_Q);
  });

  it("admin session gets the tenant-admin default copy in the flow addendum", async () => {
    h.sourceSurface = "admin";
    const res = await call();
    await res.text();
    expect(h.capturedSystem).toContain(ADMIN_Q);
    expect(h.capturedSystem).not.toContain(CUSTOMER_Q);
  });
});
