// §27.12 — The ONLY file allowed to import Anthropic / OpenAI directly.
//
// Every other call site routes through this wrapper. The wrapper:
//   1. Optionally downgrades the model per §27.6 AI-cost soft1 enforcement
//      (non-customer-facing purposes only).
//   2. Calls the vendor.
//   3. Records vendor-health success/failure (§26.9 BP26 wiring).
//   4. Writes an ai_call_log row with attribution per §27.12.
//   5. UPSERTs tenant_usage_metrics.ai_cost_cents for the current period.
//   6. Calls checkStateTransitionIfNeeded after the increment.
//
// The lint rule atc/no-direct-anthropic-or-openai-import allows ONLY this
// file (tightened from src/lib/ai/** in BP26 to this single path).

import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { resolveModelChain, attemptModelChain, HAIKU_PINNED, SONNET, OPUS_LATEST, OPUS_PINNED } from "./models";

// Re-export the Anthropic types tool-use callers need, so they don't
// have to import the SDK directly (the lint rule forbids it outside
// this file + the stream wrapper).
export type AnthropicMessage = Anthropic.Messages.Message;
export type AnthropicContentBlockParam = Anthropic.Messages.ContentBlockParam;
export type AnthropicToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
export type AnthropicToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type AnthropicTool = Anthropic.Messages.Tool;
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { getCostEstimate, primePricingCache } from "./pricing";
import {
  recordVendorFailure,
  recordVendorSuccess,
} from "@/lib/vendor-health/registry";
import { checkStateTransitionIfNeeded } from "@/lib/abuse/state-machine";
import {
  loadTenantSnapshot as loadSharedTenantSnapshot,
  PLATFORM_TENANT_ID as SHARED_PLATFORM_TENANT_ID,
  _resetSnapshotCacheForTests,
  evictTenantSnapshot,
  type CachedTenantSnapshot,
} from "@/lib/abuse/snapshot";

// D-091 Round-3 #56/#58 — wrapper-level enforcement of the §27.6 AI-cost
// state machine. Both Claude and OpenAI calls now route through the same
// state check; previously the Claude wrapper only DOWNGRADED on soft1/2
// and silently allowed `hard`, and the OpenAI embedding wrapper bypassed
// the state machine entirely. Callers should catch this and short-circuit
// with the customer-facing fallback message; throwing rather than
// returning a tagged result keeps the wrapper symmetric with vendor
// network failures.
export class AiCostHardStateError extends Error {
  readonly code = "ai_cost_hard_state" as const;
  constructor(public readonly tenant_id: string, public readonly purpose: string) {
    super(`AI cost limit (hard) reached for tenant ${tenant_id} — refusing ${purpose} call`);
    this.name = "AiCostHardStateError";
  }
}

export type AICallPurpose =
  | "chat_main"
  | "chat_supervisor"
  | "entity_extraction"
  | "memory_extraction"
  | "rag_normalization"
  | "rag_pii_redaction"
  | "rag_relevance_scoring"
  | "persona_addendum_screen"
  | "persona_addendum_rescreen"
  | "forum_moderation"
  | "precruise_generation"
  | "quote_narrative"
  | "embedding"
  | "content_normalization"
  | "other"
  // BP31 §32.4.4 — Help AI cost attribution.
  | "help_ai_main"
  | "help_ai_supervisor"
  // BP34 §34.3.2-3.3 — Inbound import parsing pipeline.
  | "import_classify"
  | "import_extract"
  // §38.8 — Agent-facing quote-builder AI co-pilot.
  | "quote_copilot"
  // §38.8.1 / §39.5 — Token-gated customer chat (quote view, itinerary).
  | "public_token_chat"
  // #902 / D-195 — TA-mode dashboard chat (audience='tenant_member').
  // Deliberately NOT in CUSTOMER_FACING_PURPOSES: staff turns accept the
  // soft-tier model downgrade (cost containment over register fidelity).
  | "ta_chat_main"
  // #904 — draft-reply composer (TA-facing; same downgrade posture as ta_chat).
  | "draft_reply";

// Purposes that run customer-facing turns. NOT downgraded at soft1.
const CUSTOMER_FACING_PURPOSES: ReadonlySet<AICallPurpose> = new Set([
  "chat_main",
  "precruise_generation",
  "quote_narrative",
]);

// PLATFORM_TENANT_ID — used for calls whose tenant attribution is genuinely
// platform-wide (cross-tenant cron embeddings, etc.). Re-exported from the
// shared snapshot module so existing imports of this constant still work.
export const PLATFORM_TENANT_ID = SHARED_PLATFORM_TENANT_ID;

// ─────────────────────────────────────────────────────────────────────
// §9.3 — Anthropic prompt caching
// ─────────────────────────────────────────────────────────────────────
//
// Anthropic's prompt cache marks a stable prefix of the request as
// reusable. When the same prefix arrives again within the cache TTL
// (~5 minutes) AND the system + model match, input tokens for the
// cached portion are billed at ~10% of the normal rate. The cache is
// content-addressed; identical text → cache hit.
//
// For chat-style calls the system prompt is the stable prefix: it
// contains the persona block, platform constraints, and (per turn)
// the RAG knowledge block. The persona block dominates token count
// and is invariant within a conversation, so caching the system
// gives a real win on multi-turn chats where the RAG block adds a
// short delta but the bulk is reused.
//
// Caveat: the cache breakpoint applies to the WHOLE text block. If
// the RAG block at the END of the system text changes turn-over-turn,
// the cache misses for the WHOLE system. A future optimization is to
// split into 2 blocks (persona = cached, RAG = uncached), but Anthropic
// only allows 4 cache breakpoints per request and the 2-block split
// is invasive. Single-block is the right MVP.
//
// Min token requirement: Anthropic only caches blocks ≥1024 tokens for
// Sonnet, ≥2048 for Opus. Below that the marker is silently ignored.
// Most personas + constraints exceed this; short system prompts
// (single-line "Be concise") won't see a benefit but also won't pay
// any cost — the API just ignores the marker.
//
// Gated by ANTHROPIC_PROMPT_CACHE_ENABLED (default true). Operator can
// flip to false for an A/B test or to debug cache-related anomalies.

type SystemArg = string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined;

export function buildSystemArg(system: string | undefined): SystemArg {
  if (!system) return undefined;
  const enabled = process.env.ANTHROPIC_PROMPT_CACHE_ENABLED;
  // envBoolean coerces to "true"/"false" strings; the default is "true" when
  // unset per env.ts. Treat anything other than the literal string "false"
  // as enabled so a misconfigured env doesn't silently disable caching.
  const cacheOn = enabled !== "false";
  if (!cacheOn) return system;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
}

// ─────────────────────────────────────────────────────────────────────
// selectModelForPurpose — §27.6 AI cost enforcement, soft1+
// ─────────────────────────────────────────────────────────────────────

const DOWNGRADE_MAP: Record<string, string> = {
  [OPUS_LATEST]: HAIKU_PINNED,
  [OPUS_PINNED]: HAIKU_PINNED,
  [SONNET]: HAIKU_PINNED,
};

export interface ModelSelectionInput {
  desired_model: string;
  purpose: AICallPurpose;
  ai_cost_state: "ok" | "soft1" | "soft2" | "hard";
}

export function selectModelForPurpose(input: ModelSelectionInput): string {
  if (input.ai_cost_state === "ok") return input.desired_model;
  if (input.ai_cost_state === "hard") return input.desired_model; // hard is enforced upstream by the wrapper (throws AiCostHardStateError before we get here)
  // soft1 + soft2: downgrade non-customer-facing purposes.
  if (CUSTOMER_FACING_PURPOSES.has(input.purpose)) return input.desired_model;
  return DOWNGRADE_MAP[input.desired_model] ?? input.desired_model;
}

// ─────────────────────────────────────────────────────────────────────
// Tenant snapshot loading
// ─────────────────────────────────────────────────────────────────────

// loadTenantSnapshot now lives in lib/abuse/snapshot.ts so the §27 counter
// helpers (lib/abuse/counters.ts) AND the BP24 streaming wrapper (stream-
// wrapper.ts) can share the same loader + 30s in-process cache.
// Re-exported here so existing imports (`from "./call-wrapper"`) keep working.
export type { CachedTenantSnapshot };
export async function loadTenantSnapshot(
  db: ReturnType<typeof createServiceRoleClient>,
  tenant_id: string,
): Promise<CachedTenantSnapshot> {
  return loadSharedTenantSnapshot(db, tenant_id);
}

// ─────────────────────────────────────────────────────────────────────
// Logging + counter increment
// ─────────────────────────────────────────────────────────────────────

function currentBillingPeriodRange(): string {
  // DATERANGE literal — `[start,end)` calendar month.
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

// Exported so the batch reconciler can write the same shape per-row
// when results land. Private to lib/ai/* by convention — callers
// outside lib/ai should not need to invoke this directly.
export async function logAndIncrement(args: {
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
}): Promise<void> {
  // D-094 — safeAwait surfaces DB errors as structured throws. Pre-fix
  // these inserts/updates silently discarded `{ error }`, so an RLS
  // hiccup or transient DB failure left the AI cost ledger diverged from
  // reality with no signal (Greptile audit #248).
  // 1. ai_call_log row.
  await safeAwait(
    args.db.from("ai_call_log").insert({
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
    }),
    "ai_call_log.insert",
  );

  // 2. tenant_usage_metrics increment. D-094 follow-up (Greptile #265):
  // pre-fix this was a SELECT → INSERT/UPDATE round trip that races on
  // the first call of a new billing period (two concurrent inserts both
  // see no row, both try to INSERT, the second hits 23505). Pre-PR-#265
  // that 23505 was silently swallowed; post-PR-#265 with safeAwait the
  // 23505 propagated as a SupabaseMutationError, making a successful
  // AI call look like a failure to the caller (with ai_call_log already
  // committed → retry-induced double-counting).
  //
  // Atomic fix: increment_tenant_ai_cost RPC does
  // INSERT … ON CONFLICT DO UPDATE SET cost = existing + incoming
  // server-side. No race, no surface. Migration 20260627000000.
  if (args.tenant_id === PLATFORM_TENANT_ID) return; // skip metrics for platform overhead

  const period = currentBillingPeriodRange();
  await safeAwait(
    args.db.rpc("increment_tenant_ai_cost", {
      p_tenant_id: args.tenant_id,
      p_billing_period: period,
      p_amount_cents: args.cost_cents.toString(),
    }),
    "tenant_usage_metrics.rpc.increment",
  );
}

// ─────────────────────────────────────────────────────────────────────
// instrumentedClaudeCall
// ─────────────────────────────────────────────────────────────────────

export interface InstrumentedClaudeArgs {
  tenant_id: string;
  conversation_id?: string | null;
  user_id?: string | null;
  model: string;
  purpose: AICallPurpose;
  max_tokens: number;
  system?: string;
  // Anthropic accepts string content OR an array of content blocks. The
  // array form is required for tool_result blocks in the tool-use loop.
  messages: Array<{
    role: "user" | "assistant";
    content: string | Anthropic.Messages.ContentBlockParam[];
  }>;
  // §9.6 — optional tool registry. Anthropic returns tool_use blocks in
  // the response content when the model decides to call one. Callers
  // dispatch + loop themselves; this wrapper just passes the param.
  tools?: Anthropic.Messages.Tool[];
}

export async function instrumentedClaudeCall(
  args: InstrumentedClaudeArgs,
): Promise<{ text: string; raw: Anthropic.Messages.Message }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("instrumentedClaudeCall: ANTHROPIC_API_KEY not set");

  const db = createServiceRoleClient();
  await primePricingCache(db);
  const snapshot = await loadTenantSnapshot(db, args.tenant_id);

  // D-091 Round-3 #56 — fail-closed at the wrapper on hard state.
  // Previously the only enforcement was at the call site (chat route's
  // pre-flight check); embeddings, supervisor, memory extract, and any
  // future caller could bypass. Centralizing here is defense-in-depth.
  if (snapshot.ai_cost_state === "hard" && args.tenant_id !== PLATFORM_TENANT_ID) {
    throw new AiCostHardStateError(args.tenant_id, args.purpose);
  }

  const model = selectModelForPurpose({
    desired_model: args.model,
    purpose: args.purpose,
    ai_cost_state: snapshot.ai_cost_state,
  });

  const anthropic = new Anthropic({ apiKey });
  const cachedSystem = buildSystemArg(args.system);
  const start = Date.now();

  // #851 — "attempt latest, fall back on issues". `model` selects the tier; the
  // chain tries the undated "latest" alias first, then the pinned snapshot, with
  // a circuit-breaker so a retired/failing snapshot degrades gracefully instead
  // of failing the call. `usedModel` (what actually served) drives cost + logging.
  // Throws only if EVERY model in the chain fails — onError logs each loudly so
  // the failure is never silent (the root of #850).
  const { result: resp, model: usedModel } = await attemptModelChain(
    resolveModelChain(model),
    (candidate) =>
      anthropic.messages.create({
        model: candidate,
        max_tokens: args.max_tokens,
        ...(cachedSystem ? { system: cachedSystem } : {}),
        messages: args.messages as Anthropic.Messages.MessageParam[],
        ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
      }),
    {
      onError: (m, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[call-wrapper] anthropic call failed (purpose=${args.purpose}, model=${m}): ${msg}`);
        recordVendorFailure("anthropic", msg);
      },
      onFallback: (preferred, used) =>
        console.warn(`[call-wrapper] ${args.purpose}: "${preferred}" unavailable — fell back to "${used}"`),
    },
  );
  recordVendorSuccess("anthropic");

  const latency_ms = Date.now() - start;
  const input_tokens = resp.usage?.input_tokens ?? 0;
  const output_tokens = resp.usage?.output_tokens ?? 0;
  const cost = getCostEstimate({ model: usedModel, input_tokens, output_tokens });

  await logAndIncrement({
    db,
    tenant_id: args.tenant_id,
    conversation_id: args.conversation_id ?? null,
    user_id: args.user_id ?? null,
    model: usedModel,
    vendor: "anthropic",
    purpose: args.purpose,
    input_tokens,
    output_tokens,
    latency_ms,
    cost_cents: cost,
  });

  // #1378: await the transition AND evict the snapshot cache so the next call on
  // this instance re-reads fresh state from DB rather than serving the stale
  // soft2→hard lag window. Fire-and-forget let the hard-boundary flip stay undetected
  // for up to 30s (the snapshot TTL), allowing overspend.
  await checkStateTransitionIfNeeded({
    db,
    tenant: snapshot.tenant,
    dimension: "ai_cost",
  }).catch((err) => console.warn("[call-wrapper] state-transition check failed:", err));
  evictTenantSnapshot(args.tenant_id);

  const text = resp.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  return { text, raw: resp };
}

// ─────────────────────────────────────────────────────────────────────
// Anthropic Message Batches — §27.12 cost optimization.
// ─────────────────────────────────────────────────────────────────────
//
// ~50% cheaper per token vs the real-time API, async (up to 24h, usually
// minutes). Right for any AICallPurpose where the caller isn't a
// customer waiting on a reply — pre-cruise email generation, memory
// extraction, RAG ingest enrichment, etc.
//
// Producers enqueue via lib/ai/batch/enqueue.ts; the flush cron
// submits via submitAnthropicBatch; the reconcile cron polls
// getAnthropicBatchStatus and streams results via getAnthropicBatchResults.

export interface BatchRequest {
  /** Pairing key — Anthropic returns this on each result row. */
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    // #2009 — structured outputs: constrains the response to a JSON schema
    // so consumers can JSON.parse the result text without fence/brace
    // heuristics. Schema rules: objects need additionalProperties:false;
    // no numeric/string length constraints (the API rejects them).
    output_config?: { format: { type: "json_schema"; schema: Record<string, unknown> } };
  };
}

export interface BatchSubmissionResult {
  /** Anthropic-issued batch identifier. */
  batch_id: string;
  /** Anthropic's processing_status field — usually "in_progress" at submit time. */
  processing_status: string;
  request_count: number;
}

export interface BatchStatus {
  batch_id: string;
  processing_status: string;
  /** Totals from Anthropic; only reliable when processing_status==='ended'. */
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at: string | null;
}

export interface BatchResultRow {
  custom_id: string;
  result:
    | { type: "succeeded"; message: Anthropic.Messages.Message }
    | { type: "errored"; error: { type: string; message: string } }
    | { type: "canceled" }
    | { type: "expired" };
}

/**
 * Submit a batch of message-creation requests. No per-request cost
 * attribution happens here — that's the reconciler's job once results
 * land, because the actual token counts aren't known at submit time.
 *
 * Vendor health is recorded so a submit failure (auth, network) shows
 * up in the same dashboard as live-call failures.
 */
export async function submitAnthropicBatch(args: {
  requests: BatchRequest[];
}): Promise<BatchSubmissionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("submitAnthropicBatch: ANTHROPIC_API_KEY not set");
  if (args.requests.length === 0) {
    throw new Error("submitAnthropicBatch: requests array is empty");
  }
  // Anthropic limit: 100,000 requests per batch, 256 MB payload. We don't
  // enforce locally; the SDK surfaces a 4xx if exceeded.

  const anthropic = new Anthropic({ apiKey });
  try {
    const batch = await anthropic.messages.batches.create({
      requests: args.requests.map((r) => ({
        custom_id: r.custom_id,
        params: {
          model: r.params.model,
          max_tokens: r.params.max_tokens,
          ...(r.params.system ? { system: r.params.system } : {}),
          messages: r.params.messages,
          ...(r.params.output_config ? { output_config: r.params.output_config } : {}),
        },
      })),
    });
    recordVendorSuccess("anthropic");
    return {
      batch_id: batch.id,
      processing_status: batch.processing_status ?? "in_progress",
      request_count: args.requests.length,
    };
  } catch (err) {
    recordVendorFailure("anthropic", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function getAnthropicBatchStatus(batch_id: string): Promise<BatchStatus> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("getAnthropicBatchStatus: ANTHROPIC_API_KEY not set");

  const anthropic = new Anthropic({ apiKey });
  try {
    const batch = await anthropic.messages.batches.retrieve(batch_id);
    recordVendorSuccess("anthropic");
    return {
      batch_id: batch.id,
      processing_status: batch.processing_status ?? "unknown",
      request_counts: {
        processing: batch.request_counts?.processing ?? 0,
        succeeded: batch.request_counts?.succeeded ?? 0,
        errored: batch.request_counts?.errored ?? 0,
        canceled: batch.request_counts?.canceled ?? 0,
        expired: batch.request_counts?.expired ?? 0,
      },
      ended_at: batch.ended_at ?? null,
    };
  } catch (err) {
    recordVendorFailure("anthropic", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Stream batch results as they're parsed. Caller iterates and persists
 * per row. Anthropic returns these as JSONL; the SDK exposes an async
 * iterator that yields one BatchResultRow per line.
 */
export async function* getAnthropicBatchResults(
  batch_id: string,
): AsyncIterableIterator<BatchResultRow> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("getAnthropicBatchResults: ANTHROPIC_API_KEY not set");

  const anthropic = new Anthropic({ apiKey });
  const stream = await anthropic.messages.batches.results(batch_id);
  for await (const entry of stream) {
    yield entry as BatchResultRow;
  }
}

// ─────────────────────────────────────────────────────────────────────
// instrumentedOpenAICall — embeddings only for now
// ─────────────────────────────────────────────────────────────────────

export interface InstrumentedOpenAIEmbeddingArgs {
  tenant_id: string;
  model: "text-embedding-3-small" | "text-embedding-3-large";
  input: string | string[];
  purpose: AICallPurpose;
}

export async function instrumentedOpenAIEmbedding(
  args: InstrumentedOpenAIEmbeddingArgs,
): Promise<{ embeddings: number[][]; raw: OpenAI.Embeddings.CreateEmbeddingResponse }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("instrumentedOpenAIEmbedding: OPENAI_API_KEY not set");

  const db = createServiceRoleClient();
  await primePricingCache(db);

  // D-091 Round-3 #58 — embeddings now route through the same §27.6
  // state machine the Claude wrapper does. Previously this path bypassed
  // the snapshot/state check entirely, so a tenant in `hard` state could
  // keep generating embeddings indefinitely.
  if (args.tenant_id !== PLATFORM_TENANT_ID) {
    const snapshot = await loadTenantSnapshot(db, args.tenant_id);
    if (snapshot.ai_cost_state === "hard") {
      throw new AiCostHardStateError(args.tenant_id, args.purpose);
    }
  }

  const openai = new OpenAI({ apiKey });
  const start = Date.now();
  let resp: OpenAI.Embeddings.CreateEmbeddingResponse;
  try {
    resp = await openai.embeddings.create({ model: args.model, input: args.input });
    recordVendorSuccess("openai");
  } catch (err) {
    recordVendorFailure("openai", err instanceof Error ? err.message : String(err));
    throw err;
  }
  const latency_ms = Date.now() - start;
  const input_tokens = resp.usage?.prompt_tokens ?? 0;
  const cost = getCostEstimate({ model: args.model, input_tokens, output_tokens: 0 });

  await logAndIncrement({
    db,
    tenant_id: args.tenant_id,
    model: args.model,
    vendor: "openai",
    purpose: args.purpose,
    input_tokens,
    output_tokens: 0,
    latency_ms,
    cost_cents: cost,
  });

  return { embeddings: resp.data.map((d) => d.embedding), raw: resp };
}
