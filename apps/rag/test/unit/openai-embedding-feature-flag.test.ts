// Issue #686 — OPENAI_EMBEDDING_BATCH_ENABLED defaults to true; explicit
// "false" / "0" turn batching off.

import { afterEach, describe, expect, it } from "vitest";
import { isEmbeddingBatchEnabled } from "@/lib/embeddings/feature-flag";

const original = process.env.OPENAI_EMBEDDING_BATCH_ENABLED;

afterEach(() => {
  if (original === undefined) delete process.env.OPENAI_EMBEDDING_BATCH_ENABLED;
  else process.env.OPENAI_EMBEDDING_BATCH_ENABLED = original;
});

describe("isEmbeddingBatchEnabled", () => {
  it("defaults to true when env var is absent (intent: shipping default-on per #686)", () => {
    delete process.env.OPENAI_EMBEDDING_BATCH_ENABLED;
    expect(isEmbeddingBatchEnabled()).toBe(true);
  });

  it("defaults to true on empty string", () => {
    process.env.OPENAI_EMBEDDING_BATCH_ENABLED = "";
    expect(isEmbeddingBatchEnabled()).toBe(true);
  });

  it("returns true for 'true'", () => {
    process.env.OPENAI_EMBEDDING_BATCH_ENABLED = "true";
    expect(isEmbeddingBatchEnabled()).toBe(true);
  });

  it("returns false for 'false' (any case)", () => {
    process.env.OPENAI_EMBEDDING_BATCH_ENABLED = "FALSE";
    expect(isEmbeddingBatchEnabled()).toBe(false);
    process.env.OPENAI_EMBEDDING_BATCH_ENABLED = "false";
    expect(isEmbeddingBatchEnabled()).toBe(false);
  });

  it("returns false for '0'", () => {
    process.env.OPENAI_EMBEDDING_BATCH_ENABLED = "0";
    expect(isEmbeddingBatchEnabled()).toBe(false);
  });
});
