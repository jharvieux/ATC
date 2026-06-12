// #1016 — runGenerationLoop. These tests pin the safety contracts of the
// generation machinery, not the wrappers' internals (instrumented call/stream
// have their own suites): a vendor failure must still end the turn politely
// (fallback delta + done + close — never a hung stream), a per-sentence slur
// hit must abort the stream and regen with the hate-speech instruction, a
// supervisor "regenerate" must re-prompt with the corrective instruction and
// UPDATE (not duplicate) the persisted candidate, tool_use must trigger
// exactly one follow-up pass, and the regen loop must stop at the hard
// ceiling no matter what the supervisor says.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runGenerationLoop,
  type GenerationSseEvent,
  type RunGenerationLoopArgs,
} from "@/lib/chat/run-generation-loop";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { instrumentedClaudeStream } from "@/lib/ai/stream-wrapper";
import { checkSentence } from "@/lib/supervisor/per-sentence-check";
import { runToolUseLoop } from "@/lib/personas/tools/run-tool-use-loop";
import { runSupervisor } from "@/lib/supervisor/run-supervisor";
import type { TenantContext } from "@/lib/db/tenant-context";

vi.mock("@/lib/ai/call-wrapper", () => ({ instrumentedClaudeCall: vi.fn() }));
vi.mock("@/lib/ai/stream-wrapper", () => ({ instrumentedClaudeStream: vi.fn() }));
// Identity passthrough — sentence assembly has its own suite; here the mocked
// stream yields ready-made "sentences" directly.
vi.mock("@/lib/ai/sentence-buffer", () => ({
  bufferToSentences: (s: AsyncIterable<string>) => s,
}));
vi.mock("@/lib/supervisor/per-sentence-check", () => ({ checkSentence: vi.fn() }));
vi.mock("@/lib/personas/tools", () => ({ PERSONA_TOOLS: [] }));
vi.mock("@/lib/personas/tools/run-tool-use-loop", () => ({ runToolUseLoop: vi.fn() }));
vi.mock("@/lib/supervisor/run-supervisor", () => ({
  runSupervisor: vi.fn(),
  HATE_SPEECH_REGEN_INSTRUCTION: "HATE_SPEECH_REGEN_INSTRUCTION_SENTINEL",
}));

const ALLOW = { action: "allow" as const, regen_count: 0, findings: [] };
const RAW = {} as never;

function svcStub() {
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  // Per-update .eq() filters — lets tests assert tenant scoping (D-091 two-layer).
  const updateFilters: Array<Array<[string, unknown]>> = [];
  let insertResult: { data: unknown; error: { message: string } | null } = {
    data: { id: "msg-1" },
    error: null,
  };
  const svc = {
    from(table: string) {
      if (table !== "messages") throw new Error(`unexpected table: ${table}`);
      return {
        insert: (row: unknown) => {
          inserts.push(row);
          return { select: () => ({ single: async () => insertResult }) };
        },
        update: (row: unknown) => {
          updates.push(row);
          const filters: Array<[string, unknown]> = [];
          updateFilters.push(filters);
          const chain = {
            eq: (col: string, val: unknown) => { filters.push([col, val]); return chain; },
            then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
          };
          return chain;
        },
      };
    },
  };
  return {
    svc: svc as unknown as SupabaseClient,
    inserts,
    updates,
    updateFilters,
    failInsert(message: string) {
      insertResult = { data: null, error: { message } };
    },
  };
}

function harness(overrides: Partial<RunGenerationLoopArgs> = {}) {
  const events: GenerationSseEvent[] = [];
  let closed = false;
  const stub = svcStub();
  const args: RunGenerationLoopArgs = {
    svc: stub.svc,
    ctx: { tenant_id: "tenant-1", source: { kind: "http_request", user_id: "auth-1" } } as TenantContext,
    tenantId: "tenant-1",
    conversationId: "conv-1",
    conversationContactId: null,
    userId: "users-1",
    customerEmail: null,
    personaSlug: "captain",
    userMessage: "hi",
    chatHistory: [{ role: "user", content: "hi" }],
    systemPrompt: "SYSTEM",
    generationModel: "model-x",
    chatPurpose: "chat_main",
    streamingEnabled: false,
    slurDenyList: [],
    retrieval: { retrieved_chunk_ids: [], citations: [], entities: { intent: "research", categories_hint: [] } },
    tenantMaxTone: 3,
    tenantAllowProfanity: false,
    send: async (ev) => { events.push(ev); },
    close: async () => { closed = true; },
    ...overrides,
  };
  return { args, events, isClosed: () => closed, ...stub };
}

function streamOf(...sentences: string[]) {
  return {
    textStream: (async function* () { yield* sentences; })(),
    done: Promise.resolve({ text: sentences.join(" "), raw: RAW }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runSupervisor).mockResolvedValue(ALLOW);
  vi.mocked(runToolUseLoop).mockResolvedValue(null);
  vi.mocked(checkSentence).mockReturnValue({ hit: false });
});

describe("non-streaming branch", () => {
  it("clean turn → complete; candidate persisted ONCE; no deltas (caller fake-streams)", async () => {
    const h = harness();
    vi.mocked(instrumentedClaudeCall).mockResolvedValue({ text: "Ahoy!", raw: RAW } as never);
    const out = await runGenerationLoop(h.args);
    expect(out).toMatchObject({ status: "complete", candidate: "Ahoy!", assistantMessageId: "msg-1" });
    expect(h.inserts).toHaveLength(1);
    expect(h.events).toEqual([]); // delivery is the caller's job on this branch
    expect(h.isClosed()).toBe(false);
  });

  it("vendor failure → polite fallback + done + close, so the client never hangs", async () => {
    const h = harness();
    vi.mocked(instrumentedClaudeCall).mockRejectedValue(new Error("529"));
    const out = await runGenerationLoop(h.args);
    expect(out).toEqual({ status: "aborted" });
    expect(h.events.map((e) => e.type)).toEqual(["delta", "supervisor", "done"]);
    expect(h.events[0]).toMatchObject({ text: expect.stringContaining("temporarily unavailable") });
    expect(h.isClosed()).toBe(true);
    expect(runSupervisor).not.toHaveBeenCalled();
  });

  it("tool_use → exactly one follow-up call carrying the tool_result messages", async () => {
    const h = harness();
    const followUp = [{ role: "user" as const, content: "tool results" }];
    vi.mocked(instrumentedClaudeCall)
      .mockResolvedValueOnce({ text: "let me check", raw: RAW } as never)
      .mockResolvedValueOnce({ text: "Deck plan sent.", raw: RAW } as never);
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      followUpMessages: followUp,
      dispatchedTools: ["send_asset"],
      mutated: false,
    });
    const out = await runGenerationLoop(h.args);
    expect(out).toMatchObject({ status: "complete", candidate: "Deck plan sent." });
    expect(instrumentedClaudeCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(instrumentedClaudeCall).mock.calls[1]?.[0]).toMatchObject({ messages: followUp });
    // Single-pass contract: the follow-up's own tool_use (if any) is not dispatched.
    expect(runToolUseLoop).toHaveBeenCalledTimes(1);
  });

  it("supervisor 'regenerate' → re-prompt WITH the corrective instruction; candidate row UPDATED not re-inserted", async () => {
    const h = harness();
    vi.mocked(instrumentedClaudeCall)
      .mockResolvedValueOnce({ text: "bad draft", raw: RAW } as never)
      .mockResolvedValueOnce({ text: "good draft", raw: RAW } as never);
    vi.mocked(runSupervisor)
      .mockResolvedValueOnce({ action: "regenerate", regen_count: 1, findings: [] })
      .mockResolvedValueOnce({ action: "allow", regen_count: 1, findings: [] });
    const out = await runGenerationLoop(h.args);
    expect(out).toMatchObject({ status: "complete", candidate: "good draft" });
    const secondSys = vi.mocked(instrumentedClaudeCall).mock.calls[1]?.[0]?.system as string;
    expect(secondSys).toContain("SYSTEM");
    expect(secondSys).toContain("flagged for tone or grounding");
    expect(h.inserts).toHaveLength(1);
    expect(h.updates).toEqual([{ content: "good draft" }]);
    // D-091 two-layer isolation: the regen UPDATE must be tenant-scoped, not id-only.
    expect(h.updateFilters[0]).toEqual([
      ["id", "msg-1"],
      ["tenant_id", "tenant-1"],
    ]);
  });

  it("lexical tone_drift finding → regen uses the hate-speech instruction, not the generic one", async () => {
    const h = harness();
    vi.mocked(instrumentedClaudeCall)
      .mockResolvedValueOnce({ text: "bad", raw: RAW } as never)
      .mockResolvedValueOnce({ text: "clean", raw: RAW } as never);
    vi.mocked(runSupervisor)
      .mockResolvedValueOnce({
        action: "regenerate",
        regen_count: 1,
        findings: [{ check: "tone_drift", details: "lexical_match:abc" }],
      } as never)
      .mockResolvedValueOnce(ALLOW);
    await runGenerationLoop(h.args);
    const secondSys = vi.mocked(instrumentedClaudeCall).mock.calls[1]?.[0]?.system as string;
    expect(secondSys).toContain("HATE_SPEECH_REGEN_INSTRUCTION_SENTINEL");
  });

  it("supervisor 'escalate' → loop stops immediately; outcome surfaced to the caller", async () => {
    const h = harness();
    vi.mocked(instrumentedClaudeCall).mockResolvedValue({ text: "draft", raw: RAW } as never);
    vi.mocked(runSupervisor).mockResolvedValue({ action: "escalate", regen_count: 0, findings: [] });
    const out = await runGenerationLoop(h.args);
    expect(out).toMatchObject({
      status: "complete",
      supervisorOutcome: { action: "escalate" },
    });
    expect(instrumentedClaudeCall).toHaveBeenCalledTimes(1);
  });

  it("supervisor never approves → exactly REGEN_HARD_CEILING (6) attempts, then the last outcome returns", async () => {
    const h = harness();
    vi.mocked(instrumentedClaudeCall).mockResolvedValue({ text: "draft", raw: RAW } as never);
    vi.mocked(runSupervisor).mockResolvedValue({ action: "regenerate", regen_count: 9, findings: [] });
    const out = await runGenerationLoop(h.args);
    expect(instrumentedClaudeCall).toHaveBeenCalledTimes(6);
    expect(out).toMatchObject({ status: "complete", supervisorOutcome: { action: "regenerate" } });
  });

  it("candidate persist failure → error event + close (fail loud, no silent 200 turn)", async () => {
    const h = harness();
    h.failInsert("insert exploded");
    vi.mocked(instrumentedClaudeCall).mockResolvedValue({ text: "draft", raw: RAW } as never);
    const out = await runGenerationLoop(h.args);
    expect(out).toEqual({ status: "aborted" });
    expect(h.events).toEqual([{ type: "error", message: "message_persist_failed" }]);
    expect(h.isClosed()).toBe(true);
    expect(runSupervisor).not.toHaveBeenCalled();
  });
});

describe("streaming branch (BP24 option B)", () => {
  const streaming = { streamingEnabled: true };

  it("clean turn → delta_start then per-sentence deltas with trailing space; complete", async () => {
    const h = harness(streaming);
    vi.mocked(instrumentedClaudeStream).mockReturnValue(streamOf("Ahoy there.", "Welcome aboard.") as never);
    const out = await runGenerationLoop(h.args);
    expect(out).toMatchObject({ status: "complete", candidate: "Ahoy there. Welcome aboard.", streamedAttempts: 1 });
    expect(h.events).toEqual([
      { type: "delta_start" },
      { type: "delta", text: "Ahoy there. " },
      { type: "delta", text: "Welcome aboard. " },
    ]);
  });

  it("per-sentence slur hit → stream aborted BEFORE the flagged sentence is sent; regen with hate-speech instruction", async () => {
    const h = harness(streaming);
    vi.mocked(instrumentedClaudeStream)
      .mockReturnValueOnce({
        textStream: (async function* () { yield "Fine sentence."; yield "FLAGGED."; })(),
        done: Promise.resolve({ text: "unused", raw: RAW }),
      } as never)
      .mockReturnValueOnce(streamOf("Clean rewrite.") as never);
    vi.mocked(checkSentence)
      .mockReturnValueOnce({ hit: false })
      .mockReturnValueOnce({ hit: true, hashedTerm: "h" })
      .mockReturnValue({ hit: false });
    const out = await runGenerationLoop(h.args);
    expect(out).toMatchObject({ status: "complete", candidate: "Clean rewrite.", perSentenceFires: 1, streamedAttempts: 2 });
    const deltas = h.events.filter((e) => e.type === "delta");
    expect(deltas).toEqual([
      { type: "delta", text: "Fine sentence. " },
      { type: "delta", text: "Clean rewrite. " },
    ]); // the flagged sentence never reached the client
    expect(h.events.some((e) => e.type === "rewriting")).toBe(true);
    const secondSys = vi.mocked(instrumentedClaudeStream).mock.calls[1]?.[0]?.system as string;
    expect(secondSys).toContain("HATE_SPEECH_REGEN_INSTRUCTION_SENTINEL");
  });

  it("ALL 6 attempts hit per-sentence aborts → fail loud (error + close), never a phantom empty turn", async () => {
    const h = harness(streaming);
    vi.mocked(instrumentedClaudeStream).mockImplementation(() => ({
      textStream: (async function* () { yield "FLAGGED."; })(),
      done: Promise.resolve({ text: "unused", raw: RAW }),
    }) as never);
    vi.mocked(checkSentence).mockReturnValue({ hit: true, hashedTerm: "h" });
    const out = await runGenerationLoop(h.args);
    // No attempt ever persisted a row or reached the supervisor — completing
    // here would hand the caller a null message id behind a string type.
    expect(out).toEqual({ status: "aborted" });
    expect(instrumentedClaudeStream).toHaveBeenCalledTimes(6);
    expect(h.inserts).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "delta")).toEqual([]);
    expect(h.events.at(-1)).toEqual({ type: "error", message: "message_persist_failed" });
    expect(h.isClosed()).toBe(true);
  });

  it("tool_use on the first pass → preamble cleared (rewriting) and the post-tool reply streamed", async () => {
    const h = harness(streaming);
    const followUp = [{ role: "user" as const, content: "tool results" }];
    vi.mocked(instrumentedClaudeStream)
      .mockReturnValueOnce(streamOf("Let me check that.") as never)
      .mockReturnValueOnce(streamOf("Deck plan sent.") as never);
    vi.mocked(runToolUseLoop).mockResolvedValueOnce({
      followUpMessages: followUp,
      dispatchedTools: ["send_asset"],
      mutated: false,
    });
    const out = await runGenerationLoop(h.args);
    expect(out).toMatchObject({ status: "complete", candidate: "Deck plan sent." });
    expect(h.events.map((e) => e.type)).toEqual([
      "delta_start", "delta", // pre-tool preamble
      "rewriting", "delta_start", "delta", // cleared, then post-tool reply
    ]);
    expect(vi.mocked(instrumentedClaudeStream).mock.calls[1]?.[0]).toMatchObject({ messages: followUp });
    expect(runToolUseLoop).toHaveBeenCalledTimes(1); // single-pass contract
  });

  it("stream vendor failure → polite fallback + done + close (aborted)", async () => {
    const h = harness(streaming);
    const done = Promise.reject(new Error("vendor down"));
    done.catch(() => {}); // textStream throws first; done may never be awaited
    vi.mocked(instrumentedClaudeStream).mockReturnValue({
      textStream: (async function* () { throw new Error("vendor down"); })(),
      done,
    } as never);
    const out = await runGenerationLoop(h.args);
    expect(out).toEqual({ status: "aborted" });
    expect(h.events.map((e) => e.type)).toEqual(["delta_start", "delta", "supervisor", "done"]);
    expect(h.isClosed()).toBe(true);
  });

  it("post-stream supervisor regen → 'rewriting' tells the client to clear the bad draft already on screen", async () => {
    const h = harness(streaming);
    vi.mocked(instrumentedClaudeStream)
      .mockReturnValueOnce(streamOf("Bad draft.") as never)
      .mockReturnValueOnce(streamOf("Good draft.") as never);
    vi.mocked(runSupervisor)
      .mockResolvedValueOnce({ action: "regenerate", regen_count: 1, findings: [] })
      .mockResolvedValueOnce({ action: "allow", regen_count: 1, findings: [] });
    const out = await runGenerationLoop(h.args);
    expect(out).toMatchObject({ status: "complete", candidate: "Good draft.", postStreamSupervisorFires: 1 });
    expect(h.events.map((e) => e.type)).toEqual([
      "delta_start", "delta",
      "rewriting", // bad draft cleared
      "delta_start", "delta",
    ]);
  });
});
