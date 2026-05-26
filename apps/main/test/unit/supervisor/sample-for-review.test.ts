// §10.5a — supervisor sample-for-review unit tests.
//
// Validates the per-category sample rate plumbing, the always-100% rate
// for escalations, the platform_settings override read, and the
// supervisor_review_queue row shape (category, snapshot, purge_after).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { maybeSampleForReview } from "@/lib/supervisor/sample-for-review";
import type { SupervisorFinding } from "@/lib/supervisor/types";

interface CallLog {
  selects: string[];
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
}

function makeFake(rates: Partial<Record<string, number>>, recentMessages: unknown[], log: CallLog): SupabaseClient {
  return {
    from(table: string) {
      log.selects.push(table);
      if (table === "platform_settings") {
        return {
          select() {
            return {
              eq(_col: string, key: string) {
                return {
                  async single() {
                    const v = rates[key];
                    return v !== undefined ? { data: { value: v } } : { data: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "messages") {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return {
                      async limit() {
                        return { data: recentMessages };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "supervisor_review_queue") {
        return {
          async insert(values: Record<string, unknown>) {
            log.inserts.push({ table, values });
            return { data: null, error: null };
          },
        };
      }
      throw new Error("unexpected table: " + table);
    },
  } as unknown as SupabaseClient;
}

const baseInput = {
  message_id: "msg-1",
  conversation_id: "conv-1",
  tenant_id: "tenant-1",
};

let savedRandom: typeof Math.random;
beforeEach(() => {
  savedRandom = Math.random;
});
afterEach(() => {
  Math.random = savedRandom;
});

describe("maybeSampleForReview — §10.5a sampling decisions", () => {
  it("ALWAYS inserts on escalation (rate = 1.0, regardless of Math.random)", async () => {
    Math.random = () => 0.99; // Above almost any rate
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, [], log);
    await maybeSampleForReview({ ...baseInput, action: "escalate", findings: [], db });
    const insert = log.inserts.find((i) => i.table === "supervisor_review_queue");
    expect(insert).toBeDefined();
    expect(insert?.values.sample_category).toBe("escalation");
  });

  it("inserts on clean_pass when Math.random < configured rate", async () => {
    Math.random = () => 0.005; // below default 0.01
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({ supervisor_sample_rate_clean_pass: 0.01 }, [], log);
    await maybeSampleForReview({ ...baseInput, action: "allow", findings: [], db });
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0]?.values.sample_category).toBe("clean_pass");
  });

  it("SKIPS clean_pass when Math.random >= configured rate", async () => {
    Math.random = () => 0.5; // above default 0.01
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({ supervisor_sample_rate_clean_pass: 0.01 }, [], log);
    await maybeSampleForReview({ ...baseInput, action: "allow", findings: [], db });
    expect(log.inserts).toHaveLength(0);
  });

  it("classifies as warning_pass when action=allow and findings include a warning", async () => {
    Math.random = () => 0.0;
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({ supervisor_sample_rate_warning_pass: 0.10 }, [], log);
    const findings: SupervisorFinding[] = [{ check: "hallucination_risk", severity: "warning", details: "" }];
    await maybeSampleForReview({ ...baseInput, action: "allow", findings, db });
    expect(log.inserts[0]?.values.sample_category).toBe("warning_pass");
  });

  it("classifies as clean_pass when findings have only info-severity", async () => {
    Math.random = () => 0.0;
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, [], log);
    const findings: SupervisorFinding[] = [{ check: "arithmetic_check", severity: "info", details: "" }];
    await maybeSampleForReview({ ...baseInput, action: "allow", findings, db });
    expect(log.inserts[0]?.values.sample_category).toBe("clean_pass");
  });

  it("classifies as regen_attempted when action=regenerate", async () => {
    Math.random = () => 0.0;
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({ supervisor_sample_rate_regen: 0.25 }, [], log);
    await maybeSampleForReview({ ...baseInput, action: "regenerate", findings: [], db });
    expect(log.inserts[0]?.values.sample_category).toBe("regen_attempted");
  });

  it("uses configured rate from platform_settings (overrides default)", async () => {
    Math.random = () => 0.6; // would PASS at default 0.01 but FAIL at configured 0.5
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({ supervisor_sample_rate_clean_pass: 0.5 }, [], log);
    await maybeSampleForReview({ ...baseInput, action: "allow", findings: [], db });
    expect(log.inserts).toHaveLength(0);
  });

  it("falls back to default rate (0.01 for clean_pass) when platform_settings has no override", async () => {
    Math.random = () => 0.005; // below default 0.01
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, [], log); // no override
    await maybeSampleForReview({ ...baseInput, action: "allow", findings: [], db });
    expect(log.inserts).toHaveLength(1);
  });

  it("falls back to default rate (0.10 for warning_pass)", async () => {
    Math.random = () => 0.05; // below default 0.10
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, [], log);
    const findings: SupervisorFinding[] = [{ check: "x", severity: "warning", details: "" }];
    await maybeSampleForReview({ ...baseInput, action: "allow", findings, db });
    expect(log.inserts).toHaveLength(1);
  });

  it("falls back to default rate (0.25 for regen)", async () => {
    Math.random = () => 0.1; // below default 0.25
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, [], log);
    await maybeSampleForReview({ ...baseInput, action: "regenerate", findings: [], db });
    expect(log.inserts).toHaveLength(1);
  });

  it("writes tenant_id / message_id / conversation_id from input on the row", async () => {
    Math.random = () => 0.0;
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, [], log);
    await maybeSampleForReview({
      message_id: "msg-X",
      conversation_id: "conv-X",
      tenant_id: "tenant-X",
      action: "escalate",
      findings: [],
      db,
    });
    const v = log.inserts[0]?.values as Record<string, unknown>;
    expect(v.tenant_id).toBe("tenant-X");
    expect(v.message_id).toBe("msg-X");
    expect(v.conversation_id).toBe("conv-X");
  });

  it("snapshots the supervisor_findings + final_action on the row", async () => {
    Math.random = () => 0.0;
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, [], log);
    const findings: SupervisorFinding[] = [
      { check: "tone_drift", severity: "critical", details: "slur" },
    ];
    await maybeSampleForReview({ ...baseInput, action: "escalate", findings, db });
    const snap = log.inserts[0]?.values.supervisor_findings_snapshot as Record<string, unknown>;
    expect(snap.findings).toEqual(findings);
    expect(snap.final_action).toBe("escalate");
  });

  it("snapshots up to N=5 recent messages as conversation context", async () => {
    Math.random = () => 0.0;
    const recent = [
      { id: "m1", role: "user", content: "hi", created_at: "2026-05-01T00:00:00Z" },
      { id: "m2", role: "assistant", content: "hello", created_at: "2026-05-01T00:00:01Z" },
    ];
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, recent, log);
    await maybeSampleForReview({ ...baseInput, action: "escalate", findings: [], db });
    const ctx = log.inserts[0]?.values.conversation_context_snapshot as { messages: unknown[] };
    expect(ctx.messages).toEqual(recent);
  });

  it("purge_after is in the FUTURE (default 90-day retention)", async () => {
    Math.random = () => 0.0;
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({}, [], log);
    const before = Date.now();
    await maybeSampleForReview({ ...baseInput, action: "escalate", findings: [], db });
    const purgeAfter = new Date(log.inserts[0]?.values.purge_after as string).getTime();
    expect(purgeAfter).toBeGreaterThan(before);
    // ~90 days from now (allow 1 min jitter)
    const expected = before + 90 * 24 * 60 * 60 * 1000;
    expect(Math.abs(purgeAfter - expected)).toBeLessThan(60 * 1000);
  });

  it("purge_after honors operator-configured retention_days override", async () => {
    Math.random = () => 0.0;
    const log: CallLog = { selects: [], inserts: [] };
    const db = makeFake({ supervisor_review_retention_days: 30 }, [], log);
    const before = Date.now();
    await maybeSampleForReview({ ...baseInput, action: "escalate", findings: [], db });
    const purgeAfter = new Date(log.inserts[0]?.values.purge_after as string).getTime();
    const expected = before + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(purgeAfter - expected)).toBeLessThan(60 * 1000);
  });
});
