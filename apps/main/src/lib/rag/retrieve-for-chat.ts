// §21.1 — Retrieval flow in chat.
//
// Single entry point for the chat handler: takes a user message + conversation
// context and returns the knowledge_block (ready for prompt injection) plus
// the citations (for the <MessageSources/> UI) and the retrieved chunk IDs
// (for the §6.10 feedback loop).
//
// The RAG service call uses signServiceJwt (BP09): RS256-signed JWT with
// tenant_id, scope=read, service_identifier="chat-service". The rag verifier
// (apps/rag/src/lib/auth/verify-service-jwt.ts) checks signature + replay
// guard + tenant_registry_shadow before allowing the retrieval.

import { extractEntities, type EntitySet } from "./entity-extraction";
import { filterChunks } from "./filter-chunks";
import { formatKnowledgeBlock, type FormattedBlock } from "./format-block";
import { RetrieveResponseSchema, type RetrievedChunk, type RetrievedAsset } from "@atc/contracts";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { sendOperatorAlert, type OperatorAlertSeverity } from "@/lib/monitoring/send-operator-alert";

export interface RetrieveForChatInput {
  message: string;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  persona_id: string;
  // Persona specialty keywords from the persona base block (§9.1).
  persona_keywords?: string[];
  // Whether the user has an active booking — drives the closed-promo gate.
  customer_has_booking?: boolean;
  // Contact ID for the §6.9 include_closed_promos_for_contact override.
  contact_id?: string | null;
  // Half-lives from platform_settings.category_halflives_days (caller fetches).
  categoryHalflives?: Record<string, number>;
}

export interface RetrieveForChatResult {
  knowledge_block: string;
  citations: FormattedBlock["citations"];
  retrieved_chunk_ids: string[];
  entities: EntitySet;
  retrieval_id: string | null;
  retrieval_latency_ms: number | null;
  // BP38/39 §33.6.4 — assets surfaced alongside the chunks.
  assets: RetrievedAsset[];
}

export async function retrieveForChat(
  input: RetrieveForChatInput,
): Promise<RetrieveForChatResult> {
  // Step 1: entity extraction (best-effort).
  const entities = await extractEntities({
    message: input.message,
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    conversation_id: input.conversation_id,
  });

  // Step 2: construct the retrieval query.
  const queryParts = [
    input.message,
    ...entities.destinations,
    ...entities.cruise_lines,
    ...entities.ships,
    ...(input.persona_keywords ?? []),
  ];
  const query = queryParts.filter((s) => s && s.length > 0).join(" ").trim();

  // Step 3: call the RAG service /retrieve.
  const ragChunks = await callRagRetrieve({
    query,
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    conversation_id: input.conversation_id,
    persona_id: input.persona_id,
    top_k: 10,
    include_closed_promos_for_contact: input.contact_id ?? null,
  });

  // Step 4: filter.
  const isPricingTopic =
    entities.categories_hint.includes("pricing") ||
    /\b(price|cost|fare|rate|deal|cheaper)\b/i.test(input.message);
  const filtered = filterChunks(ragChunks.chunks, {
    customerHasBooking: input.customer_has_booking ?? false,
    isPricingTopic,
  });

  // Step 5: format the block.
  const formatted = formatKnowledgeBlock(filtered, {
    ...(input.categoryHalflives !== undefined && { categoryHalflives: input.categoryHalflives }),
  });

  // BP38/39 §33.6.4 / §33.7 — drop any retrieved asset that isn't
  // referenced by a chunk that survived filtering. Avoids surfacing
  // hot-links for content the customer never sees.
  const survivingChunkAssetIds = new Set<string>();
  for (const c of filtered) for (const id of (c.related_asset_ids ?? [])) survivingChunkAssetIds.add(id);
  const filteredAssets = ragChunks.assets.filter((a) => survivingChunkAssetIds.has(a.asset_id));

  return {
    knowledge_block: formatted.knowledge_block,
    citations: formatted.citations,
    retrieved_chunk_ids: filtered.map((c) => c.id),
    entities,
    retrieval_id: ragChunks.retrieval_id,
    retrieval_latency_ms: ragChunks.retrieval_latency_ms,
    assets: filteredAssets,
  };
}

interface RagRetrieveCallInput {
  query: string;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  persona_id: string;
  top_k: number;
  include_closed_promos_for_contact: string | null;
}

interface RagRetrieveCallResult {
  chunks: RetrievedChunk[];
  assets: RetrievedAsset[];
  retrieval_id: string | null;
  retrieval_latency_ms: number | null;
}

// callRagRetrieve runs on every chat message, so a RAG outage or misconfig
// would otherwise fire one operator alert per message. Throttle to one alert
// per signal per window per serverless instance — enough to make an otherwise-
// silent RAG outage visible without storming the alert channel on the hot path.
const ALERT_THROTTLE_MS = 5 * 60_000;
const lastAlertAt = new Map<string, number>();

async function alertRagDegraded(
  signal: string,
  severity: OperatorAlertSeverity,
  detail: string,
): Promise<void> {
  const now = Date.now();
  if (now - (lastAlertAt.get(signal) ?? 0) < ALERT_THROTTLE_MS) return;
  lastAlertAt.set(signal, now);
  // Best-effort: an alert failure must never escalate this graceful degradation
  // (serve ungrounded chat) into a hard failure of the chat path.
  await sendOperatorAlert({ severity, signal, detail }).catch(() => {});
}

async function callRagRetrieve(
  body: RagRetrieveCallInput,
): Promise<RagRetrieveCallResult> {
  const ragServiceUrl = process.env.RAG_SERVICE_URL;
  if (!ragServiceUrl) {
    // No RAG service configured (e.g., in tests) — return empty.
    return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
  }

  // BP09 — RS256-signed JWT per call. Tenant-scoped: the JWT carries the
  // calling tenant's id, which the rag verifier cross-checks against
  // tenant_registry_shadow. The /api/retrieve handler additionally enforces
  // body.tenant_id === jwt.tenant_id (defense in depth).
  let jwt: string;
  try {
    jwt = await signServiceJwt({
      tenant_id: body.tenant_id,
      scope: "read",
      service_identifier: "chat-service",
      user_id: body.user_id ?? null,
      persona_id: body.persona_id ?? null,
    });
  } catch (err) {
    await alertRagDegraded(
      "rag_retrieve_jwt_sign_failed",
      "high",
      `RAG retrieval JWT signing failed: ${String(err)}. RAG is silently disabled for chat until the signing key is fixed.`,
    );
    return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
  }

  try {
    const res = await fetch(`${ragServiceUrl}/api/retrieve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await alertRagDegraded(
        "rag_retrieve_non_200",
        "medium",
        `RAG service returned ${res.status} for /api/retrieve. Chat is serving ungrounded answers until RAG recovers.`,
      );
      return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
    }
    // BP38 — validate the response shape at the boundary. A schema mismatch
    // means rag added/changed a field the contract hasn't caught up to;
    // surface it as a warning and fall back to empty rather than letting a
    // bad shape propagate downstream.
    const raw = await res.json();
    const parsed = RetrieveResponseSchema.safeParse(raw);
    if (!parsed.success) {
      await alertRagDegraded(
        "rag_retrieve_contract_invalid",
        "high",
        `RAG /api/retrieve response failed contract validation: ${parsed.error.message}. Likely a deploy skew between main and rag.`,
      );
      return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
    }
    return parsed.data;
  } catch (err) {
    await alertRagDegraded(
      "rag_retrieve_unreachable",
      "medium",
      `RAG service unreachable at /api/retrieve: ${String(err)}. Chat is serving ungrounded answers until RAG recovers.`,
    );
    return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
  }
}
