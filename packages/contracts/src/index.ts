// @atc/contracts — single source of truth for main↔rag API shapes.
//
// Add a new endpoint by creating a sibling module (e.g. ./foo.ts) and
// re-exporting from here. Both apps consume zod schemas (for runtime
// validation at API entry) and `z.infer` types interchangeably.

export * from "./approve";
export * from "./ingest";
export * from "./rag-events";
export * from "./retrieve";
export * from "./safe-url";
