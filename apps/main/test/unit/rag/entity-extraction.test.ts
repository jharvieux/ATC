// §21.2 — Entity extraction behavior tests.
// Without ANTHROPIC_API_KEY, the extractor returns the empty entity set so
// retrieval can proceed with the raw message as the query.

import { describe, it, expect, beforeEach } from "vitest";
import { extractEntities, _clearEntityCacheForTests } from "@/lib/rag/entity-extraction";

describe("extractEntities — §21.2", () => {
  beforeEach(() => {
    _clearEntityCacheForTests();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns the empty entity set when no API key is configured", async () => {
    const out = await extractEntities("Looking for a Mediterranean cruise next May");
    expect(out.destinations).toEqual([]);
    expect(out.cruise_lines).toEqual([]);
    expect(out.intent).toBe("research");
    expect(out.travel_dates.earliest).toBeNull();
  });

  it("caches the empty result for the same input", async () => {
    const a = await extractEntities("same input");
    const b = await extractEntities("same input");
    expect(a).toBe(b); // cache returns the SAME reference
  });
});
