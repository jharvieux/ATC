// §22.4 / §27.12 — applyRagPiiRedactResult (RAG Stage 2 batch consumer).
//
// clean = Haiku output identical to extracted_content (no PII found)
// redacted = Haiku output differs (one or more replacements made)
// quarantined = empty Haiku output OR submission missing at consumer time

import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyRagPiiRedactResult } from "@/inngest/rag-pii-redact";
import type { SupabaseClient } from "@supabase/supabase-js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const SUBMISSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const sentEvents: Array<{ name: string; data: unknown }> = [];
vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, fn: unknown) => fn,
    send: async (e: { name: string; data: unknown }) => {
      sentEvents.push(e);
    },
  },
}));

function makeDb(opts: {
  extractedContent: string | null;
  tenantRow?: Record<string, unknown> | null;
} = { extractedContent: "Hello world from Alice" }) {
  const updates: Array<Record<string, unknown>> = [];
  const tenantUpdates: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => {
      switch (table) {
        case "rag_submissions":
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: opts.extractedContent !== null
                      ? { extracted_content: opts.extractedContent }
                      : null,
                    error: null,
                  }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: () => {
                updates.push(patch);
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        case "tenants":
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.tenantRow ?? {
                    pii_quarantine_alert_window_start: null,
                    pii_quarantine_alert_count_in_window: 0,
                    pii_quarantine_recurring_days: 0,
                    pii_quarantine_last_event_at: null,
                  },
                  error: null,
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: () => {
                tenantUpdates.push(patch);
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        default:
          throw new Error(`unexpected table: ${table}`);
      }
    },
  } as unknown as SupabaseClient;
  return { db, updates, tenantUpdates };
}

describe("applyRagPiiRedactResult", () => {
  beforeEach(() => {
    sentEvents.length = 0;
  });

  it("clean: Haiku output == extracted_content → status='clean', emit normalization", async () => {
    const text = "Hello world from Anywhere";
    const { db, updates } = makeDb({ extractedContent: text });
    const res = await applyRagPiiRedactResult({
      db,
      tenant_id: TENANT,
      submission_id: SUBMISSION,
      result_text: text,
    });
    expect(res).toEqual({ status: "clean" });
    expect(updates[0]).toMatchObject({ pii_redaction_status: "clean" });
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]?.name).toBe("rag.submission_ready_for_normalization");
  });

  it("redacted: Haiku output differs → status='redacted', emit normalization", async () => {
    const { db, updates } = makeDb({ extractedContent: "Hello world from Alice" });
    const res = await applyRagPiiRedactResult({
      db,
      tenant_id: TENANT,
      submission_id: SUBMISSION,
      result_text: "Hello world from [REDACTED]",
    });
    expect(res).toEqual({ status: "redacted" });
    expect(updates[0]).toMatchObject({
      pii_redaction_status: "redacted",
      redacted_content: "Hello world from [REDACTED]",
    });
    expect(sentEvents).toHaveLength(1);
  });

  it("empty Haiku output → quarantine, no normalization", async () => {
    const { db, updates } = makeDb({ extractedContent: "Hello world" });
    const res = await applyRagPiiRedactResult({
      db,
      tenant_id: TENANT,
      submission_id: SUBMISSION,
      result_text: "",
    });
    expect(res.status).toBe("quarantined");
    expect(updates[0]).toMatchObject({
      pii_redaction_status: "quarantined",
      quarantine_categories: ["haiku_empty_response"],
    });
    expect(sentEvents.filter((e) => e.name === "rag.submission_ready_for_normalization")).toHaveLength(0);
  });

  it("submission missing at consumer → quarantine + aggregation", async () => {
    const { db, updates, tenantUpdates } = makeDb({ extractedContent: null });
    const res = await applyRagPiiRedactResult({
      db,
      tenant_id: TENANT,
      submission_id: SUBMISSION,
      result_text: "anything",
    });
    expect(res.status).toBe("quarantined");
    expect(updates[0]).toMatchObject({
      pii_redaction_status: "quarantined",
      quarantine_categories: ["submission_missing_at_consumer"],
    });
    expect(tenantUpdates).toHaveLength(1); // aggregation ran
    expect(sentEvents.filter((e) => e.name === "rag.submission_ready_for_normalization")).toHaveLength(0);
  });
});
