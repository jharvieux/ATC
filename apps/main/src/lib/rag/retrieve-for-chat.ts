// §21.1 — Retrieval flow in chat.
//
// Single entry point for the chat handler: takes a user message + conversation
// context and returns the knowledge_block (ready for prompt injection) plus
// the citations (for the <MessageSources/> UI) and the retrieved chunk IDs
// (for the §6.10 feedback loop).
//
// The RAG service call uses the simple Bearer-token pattern that the rest of
// main-app uses (see apps/main/src/app/api/admin/chunks/post-termination/route.ts).
// Proper RS256 JWT signing per BP09 lands when the chat handler is wired up
// in BP24 — TODO(bp24-chat-service-jwt).

import { extractEntities, type EntitySet } from "./entity-extraction";
import { filterChunks } from "./filter-chunks";
import { formatKnowledgeBlock, type FormattedBlock } from "./format-block";
import { RetrieveResponseSchema, type RetrievedChunk, type RetrievedAsset } from "@atc/contracts";

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

async function callRagRetrieve(
  body: RagRetrieveCallInput,
): Promise<RagRetrieveCallResult> {
  const ragServiceUrl = process.env.RAG_SERVICE_URL;
  if (!ragServiceUrl) {
    // No RAG service configured (e.g., in tests) — return empty.
    return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
  }

  // TODO(bp24-chat-service-jwt): replace with RS256-signed JWT per BP09 contract.
  const bearer = process.env.SERVICE_JWT_PRIVATE_KEY ?? "";

  try {
    const res = await fetch(`${ragServiceUrl}/api/retrieve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[retrieve-for-chat] RAG service ${res.status}`);
      return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
    }
    // BP38 — validate the response shape at the boundary. A schema mismatch
    // means rag added/changed a field the contract hasn't caught up to;
    // surface it as a warning and fall back to empty rather than letting a
    // bad shape propagate downstream.
    const raw = await res.json();
    const parsed = RetrieveResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[retrieve-for-chat] RAG response failed contract validation:", parsed.error.message);
      return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
    }
    return parsed.data;
  } catch (err) {
    console.warn("[retrieve-for-chat] RAG service unreachable:", String(err));
    return { chunks: [], assets: [], retrieval_id: null, retrieval_latency_ms: null };
  }
}
