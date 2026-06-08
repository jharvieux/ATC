// §21.2 — Entity extraction behavior tests.
// Without ANTHROPIC_API_KEY, the extractor returns the empty entity set so
// retrieval can proceed with the raw message as the query.
//
// #851 — failures must be LOUD, never silent. A swallowed error here disables
// #826's ship+date itinerary lookup for the whole turn (the root of #850), so
// both the no-key path and the call-failure path must log.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/ai/call-wrapper", () => ({ instrumentedClaudeCall: mocks.call }));

import { extractEntities, _clearEntityCacheForTests } from "@/lib/rag/entity-extraction";

describe("extractEntities — §21.2", () => {
  beforeEach(() => {
    _clearEntityCacheForTests();
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("[#851] LOGS (never silent) when no API key is configured", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await extractEntities({ message: "NCL Bliss 2026-10-03", tenant_id: "t1" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY not set"));
  });

  it("[#851] logs + degrades to empty (not a throw, not silent) when the model call fails", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mocks.call.mockRejectedValue(new Error("404 not_found_error: model retired"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await extractEntities({
      message: "itinerary for the bliss on 10/3/26",
      tenant_id: "t1",
      conversation_id: "c1",
      user_id: "u1",
    });

    // Best-effort preserved: retrieval still proceeds with empty entities…
    expect(out.ships).toEqual([]);
    expect(out.travel_dates.earliest).toBeNull();
    // …but the failure is now LOUD (this is what was missing → #850 stayed invisible).
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[entity-extraction] failed"),
      expect.stringContaining("not_found_error"),
    );
    expect(mocks.call).toHaveBeenCalledTimes(1); // it DID attempt the call (key present)
  });
});
