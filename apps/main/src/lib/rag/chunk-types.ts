// §21 — Retrieved chunk shape as the chat-side consumer sees it.
//
// BP38: Types come from the @atc/contracts package (single source of truth
// for the main↔rag boundary). This file is kept as a thin re-export so
// existing imports (`@/lib/rag/chunk-types`) continue to work; new code
// should import from "@atc/contracts" directly.
export type {
  RetrievedChunk,
  RetrievedChunkScoring,
  RetrievedChunkMetadata,
  RetrievedAsset,
} from "@atc/contracts";
