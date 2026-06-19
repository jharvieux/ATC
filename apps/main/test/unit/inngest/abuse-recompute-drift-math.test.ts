// §27.7 — abuse-recompute-nightly drift math (P2 for #1217).
//
// The nightly safety-net cron reconciles real-time usage counters against the
// ground-truth source tables. These pure helpers are the recompute core that
// the 2026-06-17 Stryker sweep flagged (file was 3%, error-injection only):
// the cost SUM (money), the drift tolerance gate, the email-deliverability
// filter, and the RAG fail-safe that leaves the stored chunk count alone when
// the rag service is unreachable.

import { describe, it, expect } from "vitest";
import {
  sumCostCents,
  driftExceedsTolerance,
  countDeliverableEmails,
  computeRagDrift,
} from "@/inngest/abuse-recompute-nightly";

describe("sumCostCents", () => {
  it("empty input sums to 0n", () => {
    expect(sumCostCents([])).toBe(0n);
  });

  it("sums mixed string and number cents", () => {
    expect(sumCostCents([{ cost_estimate_cents: "150" }, { cost_estimate_cents: 49 }])).toBe(199n);
  });

  // Monthly AI spend can exceed Number.MAX_SAFE_INTEGER cents in aggregate;
  // accumulating as Number would silently lose precision. bigint must not.
  it("preserves precision past Number.MAX_SAFE_INTEGER", () => {
    expect(sumCostCents([{ cost_estimate_cents: "9007199254740993" }])).toBe(9007199254740993n);
  });
});

describe("driftExceedsTolerance", () => {
  // ai_cost path: tolerance 1n — a one-cent rounding difference must NOT churn.
  it("delta equal to tolerance does not count as drift (1-cent rounding ignored)", () => {
    expect(driftExceedsTolerance(100n, 101n, 1n)).toBe(false);
  });
  it("delta one past tolerance is drift", () => {
    expect(driftExceedsTolerance(100n, 102n, 1n)).toBe(true);
  });
  it("is symmetric when recomputed is below real-time", () => {
    expect(driftExceedsTolerance(102n, 100n, 1n)).toBe(true);
    expect(driftExceedsTolerance(101n, 100n, 1n)).toBe(false);
  });

  // count dimensions: tolerance 0n — any difference is real drift, equal is not.
  it("with tolerance 0n, equal values are not drift", () => {
    expect(driftExceedsTolerance(7n, 7n, 0n)).toBe(false);
  });
  it("with tolerance 0n, off-by-one is drift", () => {
    expect(driftExceedsTolerance(7n, 8n, 0n)).toBe(true);
  });
});

describe("countDeliverableEmails", () => {
  it("excludes suppressed and failed; counts everything else", () => {
    const rows = [
      { status: "sent" },
      { status: "bounced" },
      { status: "queued" },
      { status: "suppressed" },
      { status: "failed" },
    ];
    expect(countDeliverableEmails(rows)).toBe(3);
  });

  it("empty input is 0", () => {
    expect(countDeliverableEmails([])).toBe(0);
  });

  it("counts bounced (it left the building) but not suppressed", () => {
    expect(countDeliverableEmails([{ status: "bounced" }, { status: "suppressed" }])).toBe(1);
  });
});

describe("computeRagDrift", () => {
  it("flags promoted drift and puts the recomputed count in the update", () => {
    const r = computeRagDrift({ promotedTrue: 5, promotedRt: 3, chunksTrue: 10, chunksRt: 10 });
    expect(r.promotedDrifted).toBe(true);
    expect(r.chunksDrifted).toBe(false);
    expect(r.update).toEqual({ promoted_chunks_count: 5 });
  });

  it("flags chunk drift when the rag count differs", () => {
    const r = computeRagDrift({ promotedTrue: 3, promotedRt: 3, chunksTrue: 42, chunksRt: 40 });
    expect(r.chunksDrifted).toBe(true);
    expect(r.update).toEqual({ current_tenant_chunks_count: 42 });
  });

  // Fail-safe (source comment lines ~228-230): when the rag service fetch
  // failed, chunksTrue is undefined and we must NOT touch the stored chunk
  // count — never report drift, never include the column in the update.
  it("leaves the chunk count alone when the rag fetch failed (chunksTrue undefined)", () => {
    const r = computeRagDrift({ promotedTrue: 3, promotedRt: 3, chunksTrue: undefined, chunksRt: 40 });
    expect(r.chunksDrifted).toBe(false);
    expect(r.update).toEqual({});
  });

  // 0 is a legitimate recomputed count (tenant dropped to zero chunks), NOT a
  // failed fetch — only `undefined` is the fetch-failed sentinel. Guards the
  // `!== undefined` check against a mutation to `!= null` / `!== null`.
  it("chunksTrue=0 with a non-zero stored count is real drift", () => {
    const r = computeRagDrift({ promotedTrue: 3, promotedRt: 3, chunksTrue: 0, chunksRt: 5 });
    expect(r.chunksDrifted).toBe(true);
    expect(r.update).toEqual({ current_tenant_chunks_count: 0 });
  });

  it("undefined chunksTrue still allows promoted drift to be corrected", () => {
    const r = computeRagDrift({ promotedTrue: 9, promotedRt: 3, chunksTrue: undefined, chunksRt: 40 });
    expect(r.promotedDrifted).toBe(true);
    expect(r.chunksDrifted).toBe(false);
    expect(r.update).toEqual({ promoted_chunks_count: 9 });
  });

  it("no drift when both match — empty update", () => {
    const r = computeRagDrift({ promotedTrue: 3, promotedRt: 3, chunksTrue: 40, chunksRt: 40 });
    expect(r.promotedDrifted).toBe(false);
    expect(r.chunksDrifted).toBe(false);
    expect(r.update).toEqual({});
  });
});
