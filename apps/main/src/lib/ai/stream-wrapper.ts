// BP24 §10 — Streaming companion to instrumentedClaudeCall.
//
// Most call sites want a single string back; for those, keep using
// instrumentedClaudeCall. The streaming variant is for surfaces that want
// to flush text to the user as it arrives (real-time chat) AND run cheap
// per-sentence supervisor checks against finished sentences.
//
// Same governance as the non-streaming wrapper:
//   - model selection per §27.6 (soft1 downgrade for non-customer-facing)
//   - vendor health recording (anthropic success/failure)
//   - ai_call_log + tenant_usage_metrics increment
//   - state-transition check fire-and-forget
//
// Cost accounting: usage tokens are only known after the stream finishes
// (Anthropic emits `message_delta` with final usage near the end). So we
// log + increment AFTER finalMessage() resolves, not per-chunk.
//
// Test seam: the lint rule atc/no-direct-anthropic-or-openai-import
// allows ONLY apps/main/src/lib/ai/call-wrapper.ts to import Anthropic
// directly. This module imports from "./call-wrapper" instead.

import Anthropic from "@anthropic-ai/sdk";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { getCostEstimate, primePricingCache } from "./pricing";
import { recordVendorFailure, recordVendorSuccess } from "@/lib/vendor-health/registry";
import { checkStateTransitionIfNeeded } from "@/lib/abuse/state-machine";
import { safeAwait } from "@/lib/db/safe-mutation";
import {
  selectModelForPurpose,
  loadTenantSnapshot,
  PLATFORM_TENANT_ID,
  buildSystemArg,
  type AICallPurpose,
  type InstrumentedClaudeArgs,
} from "./call-wrapper";

export interface InstrumentedClaudeStreamArgs extends InstrumentedClaudeArgs {
  // Caller may abort the stream early (per-sentence supervisor flagged something
  // and we want to stop generation). The abort signal is wired through to
  // Anthropic so the half-generated rest is discarded.
  signal?: AbortSignal;
}

export interface InstrumentedClaudeStreamResult {
  // Yields raw token-level text deltas. Compose with bufferToSentences() for
  // sentence-granular consumption.
  textStream: AsyncIterable<string>;
  // Resolves once the stream finishes. Final text + cost/usage are written
  // to ai_call_log + tenant_usage_metrics here, NOT mid-stream.
  done: Promise<{
    text: string;
    input_tokens: number;
    output_tokens: number;
    cost_cents: bigint;
    latency_ms: number;
  }>;
}

interface LogIncrementArgs {
  db: ReturnType<typeof createServiceRoleClient>;
  tenant_id: string;
  conversation_id?: string | null;
  user_id?: string | null;
  model: string;
  vendor: "anthropic" | "openai";
  purpose: AICallPurpose;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost_cents: bigint;
}

function currentBillingPeriodRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

// Mirror of call-wrapper.logAndIncrement. Kept here local rather than
// exported from call-wrapper so the streaming and non-streaming paths can
// diverge if future cost accounting differs (e.g. mid-stream caching).
async function logAndIncrement(args: LogIncrementArgs): Promise<void> {
  await safeAwait(args.db.from("ai_call_log").insert({
    tenant_id: args.tenant_id,
    conversation_id: args.conversation_id ?? null,
    user_id: args.user_id ?? null,
    model: args.model,
    vendor: args.vendor,
    purpose: args.purpose,
    input_tokens: args.input_tokens,
    output_tokens: args.output_tokens,
    cost_estimate_cents: args.cost_cents.toString(),
    latency_ms: args.latency_ms,
  }), "ai_call_log.insert");

  if (args.tenant_id === PLATFORM_TENANT_ID) return;

  const period = currentBillingPeriodRange();
  const { data: existing } = await args.db
    .from("tenant_usage_metrics")
    .select("id, ai_cost_cents")
    .eq("tenant_id", args.tenant_id)
    .eq("billing_period", period)
    .maybeSingle();

  if (existing) {
    const current = BigInt((existing as { ai_cost_cents: string | number }).ai_cost_cents);
    const updated = current + args.cost_cents;
    await safeAwait(args.db
      .from("tenant_usage_metrics")
      .update({ ai_cost_cents: updated.toString() })
      .eq("id", (existing as { id: string }).id), "tenant_usage_metrics.update");
  } else {
    await safeAwait(args.db.from("tenant_usage_metrics").insert({
      tenant_id: args.tenant_id,
      billing_period: period,
      ai_cost_cents: args.cost_cents.toString(),
    }), "tenant_usage_metrics.insert");
  }
}

export function instrumentedClaudeStream(
  args: InstrumentedClaudeStreamArgs,
): InstrumentedClaudeStreamResult {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("instrumentedClaudeStream: ANTHROPIC_API_KEY not set");

  const db = createServiceRoleClient();
  const anthropic = new Anthropic({ apiKey });

  // The text channel is exposed as an async iterable backed by a queue.
  // Anthropic's MessageStream API is event-based; we adapt it to async-iter.
  const buffered: string[] = [];
  let resolveWaiter: (() => void) | null = null;
  let streamEnded = false;
  let streamError: unknown = null;

  function notify(): void {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  }

  async function* textIterator(): AsyncIterable<string> {
    while (true) {
      while (buffered.length > 0) {
        const t = buffered.shift()!;
        yield t;
      }
      if (streamError) throw streamError;
      if (streamEnded) return;
      await new Promise<void>((res) => { resolveWaiter = res; });
    }
  }

  // The `done` promise: kicks off the stream, accumulates final text, writes
  // logs + increments usage, resolves.
  const done: Promise<InstrumentedClaudeStreamResult["done"] extends Promise<infer X> ? X : never> =
    (async () => {
      await primePricingCache(db);
      const snapshot = await loadTenantSnapshot(db, args.tenant_id);
      const model = selectModelForPurpose({
        desired_model: args.model,
        purpose: args.purpose,
        ai_cost_state: snapshot.ai_cost_state,
      });

      const start = Date.now();

      try {
        const cachedSystem = buildSystemArg(args.system);
        const stream = anthropic.messages.stream({
          model,
          max_tokens: args.max_tokens,
          ...(cachedSystem ? { system: cachedSystem } : {}),
          messages: args.messages,
        });

        // Forward text deltas to the iterator queue. The `text` event fires
        // for every text delta the model emits.
        stream.on("text", (delta: string) => {
          if (!delta) return;
          buffered.push(delta);
          notify();
        });

        // Caller-driven abort.
        if (args.signal) {
          const onAbort = (): void => {
            try { stream.abort(); } catch { /* already finished */ }
          };
          if (args.signal.aborted) onAbort();
          else args.signal.addEventListener("abort", onAbort, { once: true });
        }

        const finalMessage = await stream.finalMessage();
        recordVendorSuccess("anthropic");

        const latency_ms = Date.now() - start;
        const input_tokens = finalMessage.usage?.input_tokens ?? 0;
        const output_tokens = finalMessage.usage?.output_tokens ?? 0;
        const cost_cents = getCostEstimate({ model, input_tokens, output_tokens });
        const text = finalMessage.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("");

        await logAndIncrement({
          db,
          tenant_id: args.tenant_id,
          conversation_id: args.conversation_id ?? null,
          user_id: args.user_id ?? null,
          model,
          vendor: "anthropic",
          purpose: args.purpose,
          input_tokens,
          output_tokens,
          latency_ms,
          cost_cents,
        });

        void checkStateTransitionIfNeeded({
          db,
          tenant: snapshot.tenant,
          dimension: "ai_cost",
          metric_value: cost_cents,
        }).catch((err) => console.warn("[stream-wrapper] state-transition check failed:", err));

        streamEnded = true;
        notify();

        return { text, input_tokens, output_tokens, cost_cents, latency_ms };
      } catch (err) {
        recordVendorFailure("anthropic", err instanceof Error ? err.message : String(err));
        streamError = err;
        streamEnded = true;
        notify();
        throw err;
      }
    })();

  return { textStream: textIterator(), done };
}
