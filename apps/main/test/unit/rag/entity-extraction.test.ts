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

  it("[#851] warns + degrades to empty when the model returns unparseable output", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mocks.call.mockResolvedValue({ text: "sorry, I can't help with that", raw: {} });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await extractEntities({ message: "the bliss on 10/3/26", tenant_id: "t1" });

    expect(out.ships).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("could not parse model output"));
  });

  it("passes context_messages to the model and uses the result (follow-up query resolution)", async () => {
    // WHY: "Can you send me the deck plan?" after discussing Norwegian Bliss
    // previously returned zero ships because entity extraction only saw the
    // current message. Passing context lets the model infer the ship.
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mocks.call.mockResolvedValue({
      text: JSON.stringify({ destinations: [], departure_ports: [], cruise_lines: [], ships: ["Norwegian Bliss"], travel_dates: { earliest: null, latest: null }, passenger_composition: "", intent: "research", categories_hint: [] }),
      raw: {},
    });

    const out = await extractEntities({
      message: "Can you send me the deck plan?",
      tenant_id: "t1",
      context_messages: [
        { role: "user", text: "What is the itinerary for Norwegian Bliss on October 3 2026?" },
        { role: "assistant", text: "Norwegian Bliss departs Seattle on Oct 3 2026 for a 7-night Alaska cruise." },
      ],
    });

    expect(out.ships).toEqual(["Norwegian Bliss"]);
    const callArg = mocks.call.mock.calls[0]?.[0];
    const userContent = (callArg?.messages?.[0]?.content ?? "") as string;
    expect(userContent).toContain("context_turn");
    expect(userContent).toContain("Norwegian Bliss");
  });

  it("same message with different context produces a cache miss (not the same object)", async () => {
    // WHY: cache key must include context so "send the deck plan" about
    // Norwegian Bliss and "send the deck plan" about Disney Wish don't collide.
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mocks.call.mockResolvedValue({ text: '{"destinations":[],"departure_ports":[],"cruise_lines":[],"ships":[],"travel_dates":{"earliest":null,"latest":null},"passenger_composition":"","intent":"research","categories_hint":[]}', raw: {} });

    const a = await extractEntities({ message: "send the deck plan", tenant_id: "t1", context_messages: [{ role: "user", text: "Tell me about Norwegian Bliss" }] });
    const b = await extractEntities({ message: "send the deck plan", tenant_id: "t1", context_messages: [{ role: "user", text: "Tell me about Disney Wish" }] });

    expect(a).not.toBe(b); // different cache entries
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });
});
