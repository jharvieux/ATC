// #1759/#1781 — pre-generation gate phase, extracted verbatim from handleChat.
//
// Runs the checks that must pass BEFORE the streaming wrapper is acquired:
// the ANTHROPIC_API_KEY presence check, and the §10.6/§26.9 AI kill-switch
// gates (resolveAiAvailability). On failure, terminal SSE events are already
// sent and the stream is closed — the caller just returns. On success,
// resolves the generation model/purpose, the streaming-mode flag, and the
// per-sentence-supervisor deny list.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAiAvailability } from "@/lib/chat/resolve-ai-availability";
import { loadUnionSlurDenyList } from "@/lib/supervisor/load-deny-list";
import type { ChatAudience } from "@/lib/personas/build-system-prompt";

// The SSE events this phase emits — a structural subset of the route's
// SseEvent union, so the route's `send` is directly assignable.
export type PrepareGenerationSseEvent =
  | { type: "delta"; text: string }
  | { type: "supervisor"; action: "allow"; regens: number }
  | { type: "error"; message: string }
  | { type: "done" };

export type PrepareGenerationResult =
  | {
      ready: true;
      generationModel: string;
      chatPurpose: "chat_main" | "ta_chat_main";
      streamingEnabled: boolean;
      slurDenyList: string[];
    }
  // Terminal SSE events already sent and the stream closed — caller returns.
  | { ready: false };

export async function prepareGeneration(args: {
  svc: SupabaseClient;
  tenantId: string;
  audience: ChatAudience;
  tenantAiPaused: boolean;
  bumpConfigReads: () => void;
  send: (ev: PrepareGenerationSseEvent) => Promise<void>;
  close: () => Promise<void>;
}): Promise<PrepareGenerationResult> {
  const { svc, tenantId, audience, tenantAiPaused, bumpConfigReads, send, close } = args;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await send({ type: "error", message: "anthropic_api_key_not_configured" });
    await close();
    return { ready: false };
  }

  // §10.6 / §26.9 / D-091 Round-3 #43 — the three AI kill-switch gates (global
  // pause, per-tenant pause, vendor-health down) resolved together BEFORE the
  // streaming wrapper is acquired, so a paused AI can't leak partial tokens or
  // burn a vendor call. See resolveAiAvailability for the fail-open/order rules.
  const availability = await resolveAiAvailability({ svc, tenantAiPaused, bumpConfigReads });
  if (!availability.available) {
    await send({ type: "delta", text: availability.fallbackBody });
    await send({ type: "supervisor", action: "allow", regens: 0 });
    await send({ type: "done" });
    await close();
    return { ready: false };
  }

  const generationModel = process.env.CHAT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";
  // #902 — separate cost attribution for TA turns (and TA accepts the
  // soft-tier model downgrade; see AICallPurpose).
  const chatPurpose = audience === "tenant_member" ? ("ta_chat_main" as const) : ("chat_main" as const);

  // BP24 — Streaming-mode opt-in. Default off; flip CHAT_STREAMING_ENABLED=true
  // in the runtime env to route the chat reply through the streaming wrapper
  // + per-sentence supervisor (§10 option B). When off, the existing whole-
  // response + fake-stream path runs untouched.
  const streamingEnabled = process.env.CHAT_STREAMING_ENABLED === "true";

  // Per-sentence supervisor uses the same union deny-list runSupervisor
  // uses. Load it once per turn (not per attempt) to avoid 2 extra reads
  // on every regen.
  const slurDenyList = streamingEnabled ? await loadUnionSlurDenyList(svc, tenantId) : [];

  return { ready: true, generationModel, chatPurpose, streamingEnabled, slurDenyList };
}
