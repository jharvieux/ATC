// #904 — POST /api/draft-reply contracts:
//   - assertPermission(draft_reply:create) IS the auth gate (viewer denied
//     by the grants matrix; tested there).
//   - daily cap fail-closed → 429, model never called.
//   - voice profile present → VOICE block in the system prompt; absent →
//     voice_profile_missing flag (the settings nudge).
//   - [name] placeholder instruction when customer_name is null.
//   - DRAFT-ONLY: the route module has no send path (pinned below).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  permError: null as string | null,
  publicUserId: "users-1" as string | null,
  limitAllowed: true,
  voice: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => {
    if (h.permError) throw new Error(h.permError);
    return { ctx: { tenant_id: "tenant-1", source: { kind: "http_request", user_id: "auth-1" } } };
  }),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })),
}));
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte"]) chain[m] = () => chain;
      chain.maybeSingle = async () => {
        if (table === "users") return { data: h.publicUserId ? { id: h.publicUserId } : null, error: null };
        return { data: null, error: null };
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/draft/draft-reply-limit", () => ({
  enforceDraftReplyLimit: vi.fn(async () =>
    h.limitAllowed
      ? { allowed: true, current_count: 1, cap: 100 }
      : { allowed: false, current_count: 100, cap: 100, reason: "cap" },
  ),
}));
vi.mock("@/lib/voice-profiles/resolve-voice-profile", () => ({
  resolveVoiceProfile: vi.fn(async () => h.voice),
}));
vi.mock("@/lib/rag/retrieve-for-chat", () => ({
  retrieveForChat: vi.fn(async () => ({
    knowledge_block: "KNOWLEDGE", citations: [], retrieved_chunk_ids: [],
    entities: {}, retrieval_id: null, retrieval_latency_ms: null, assets: [],
  })),
}));
vi.mock("@/lib/personas/build-system-prompt", () => ({
  buildSystemPrompt: vi.fn(async () => ({ prompt: "SYSTEM_BASE", cacheKey: "k" })),
}));
vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: vi.fn(async () => ({ text: "Hi [name],\n\nDraft body.", raw: {} })),
}));

import { POST } from "@/app/api/draft-reply/route";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";

function req(body: Record<string, unknown>): Request {
  return new Request("https://t.example.com/api/draft-reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD = { inquiry: "Caribbean in July for our anniversary?", persona_slug: "marcus-cole" };

beforeEach(() => {
  vi.clearAllMocks();
  h.permError = null;
  h.publicUserId = "users-1";
  h.limitAllowed = true;
  h.voice = null;
});

describe("POST /api/draft-reply (#904)", () => {
  it("happy path: returns the draft + voice_profile_missing flag when no profile", async () => {
    const res = await POST(req(GOOD));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { draft: string; voice_profile_missing: boolean };
    expect(data.draft).toContain("Draft body");
    expect(data.voice_profile_missing).toBe(true);
  });

  it("voice profile present → VOICE block reaches the system prompt; flag false", async () => {
    h.voice = { style_card: { greeting: "Hi {first}," }, card_override: null, source: "own" };
    const res = await POST(req(GOOD));
    const data = (await res.json()) as { voice_profile_missing: boolean };
    expect(data.voice_profile_missing).toBe(false);
    const sys = vi.mocked(instrumentedClaudeCall).mock.calls[0]![0].system as string;
    expect(sys).toContain("THE AGENT'S WRITING VOICE");
    expect(sys).toContain("Hi {first},");
  });

  it("audience is tenant_member (TA register, never customer prompts)", async () => {
    await POST(req(GOOD));
    expect(vi.mocked(buildSystemPrompt).mock.calls[0]![0]).toMatchObject({ audience: "tenant_member" });
  });

  it("unknown tone label → 400, model never called", async () => {
    const res = await POST(req({ ...GOOD, tone: "Cheery" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_tone");
    expect(instrumentedClaudeCall).not.toHaveBeenCalled();
  });

  it("Formal tone label → tone_level 1 reaches buildSystemPrompt", async () => {
    await POST(req({ ...GOOD, tone: "Formal" }));
    expect(vi.mocked(buildSystemPrompt).mock.calls[0]![0]).toMatchObject({ tone_level: 1 });
  });

  it("omitted tone → tone_level 3 (default) reaches buildSystemPrompt", async () => {
    await POST(req(GOOD));
    expect(vi.mocked(buildSystemPrompt).mock.calls[0]![0]).toMatchObject({ tone_level: 3 });
  });

  it("no customer_name → the [name] placeholder instruction, never an invented name", async () => {
    await POST(req(GOOD));
    const userMsg = vi.mocked(instrumentedClaudeCall).mock.calls[0]![0].messages[0]!.content as string;
    expect(userMsg).toContain("[name]");
    expect(userMsg).toContain("Do NOT invent a name");
  });

  it("customer_name supplied → greeting instruction names them", async () => {
    await POST(req({ ...GOOD, customer_name: "Sarah" }));
    const userMsg = vi.mocked(instrumentedClaudeCall).mock.calls[0]![0].messages[0]!.content as string;
    expect(userMsg).toContain('"Sarah"');
  });

  it("cap hit → 429, model never called", async () => {
    h.limitAllowed = false;
    const res = await POST(req(GOOD));
    expect(res.status).toBe(429);
    expect(instrumentedClaudeCall).not.toHaveBeenCalled();
  });

  it("permission failure → auth responder (403), nothing runs", async () => {
    h.permError = "forbidden";
    const res = await POST(req(GOOD));
    expect(res.status).toBe(403);
    expect(instrumentedClaudeCall).not.toHaveBeenCalled();
  });

  it("empty inquiry / missing persona → 400", async () => {
    expect((await POST(req({ inquiry: "", persona_slug: "x" }))).status).toBe(400);
    expect((await POST(req({ inquiry: "hello there friend" }))).status).toBe(400);
  });

  it("DRAFT-ONLY contract: the route imports no email/send module and exports only POST", () => {
    const src = readFileSync(
      join(process.cwd(), "apps", "main", "src", "app", "api", "draft-reply", "route.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/sendEmail|resend|nodemailer|smtp/i);
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+(GET|PUT|DELETE|PATCH)/);
  });
});
