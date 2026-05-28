// §27.12 — applyRescreenResult (rescreen batch consumer) behavior.
//
// Pass keeps the addendum approved (cache the result). Fail suspends
// it AND notifies tenant owners AND audit-logs — different from the
// initial-screen consumer, which rejects.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyRescreenResult } from "@/inngest/persona-addendum-rescreen-nightly";
import type { SupabaseClient } from "@supabase/supabase-js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const ADDENDUM = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SLUG = "balanced";

const auditCalls: unknown[] = [];
vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: async (e: unknown) => {
    auditCalls.push(e);
  },
}));

const notifyCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/email/notifications", () => ({
  sendTenantNotification: async (e: Record<string, unknown>) => {
    notifyCalls.push(e);
  },
}));

function makeDb(opts: { owners?: Array<{ email: string }> } = {}) {
  const owners = opts.owners ?? [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => {
      switch (table) {
        case "persona_addendums":
          return {
            update: (patch: Record<string, unknown>) => ({
              eq: () => {
                updates.push(patch);
                return Promise.resolve({ data: null, error: null });
              },
            }),
          };
        case "users":
          return {
            select: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: owners, error: null }),
              }),
            }),
          };
        default:
          throw new Error(`unexpected table: ${table}`);
      }
    },
  } as unknown as SupabaseClient;
  return { db, updates };
}

describe("applyRescreenResult", () => {
  beforeEach(() => {
    auditCalls.length = 0;
    notifyCalls.length = 0;
  });

  it("pass: writes screen_result + screened_at, no status change, no audit, no notify", async () => {
    const { db, updates } = makeDb();
    const res = await applyRescreenResult({
      db,
      tenant_id: TENANT,
      addendum_id: ADDENDUM,
      persona_slug: SLUG,
      result_text: '{"pass": true, "findings": []}',
    });
    expect(res).toEqual({ status: "approved", findings_count: 0 });
    expect(updates).toHaveLength(1);
    const patch = updates[0] as Record<string, unknown>;
    expect(patch).toHaveProperty("haiku_screen_result");
    expect(patch).toHaveProperty("haiku_screened_at");
    expect(patch).not.toHaveProperty("status");
    expect(auditCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);
  });

  it("fail: suspends, audits, notifies all active owners", async () => {
    const { db, updates } = makeDb({
      owners: [{ email: "owner1@example.com" }, { email: "owner2@example.com" }],
    });
    const res = await applyRescreenResult({
      db,
      tenant_id: TENANT,
      addendum_id: ADDENDUM,
      persona_slug: SLUG,
      result_text:
        '{"pass": false, "findings": [{"category": "prompt_injection", "evidence": "ignore previous"}]}',
    });
    expect(res).toEqual({ status: "suspended", findings_count: 1 });
    expect(updates).toHaveLength(1);
    const patch = updates[0] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: "suspended" });
    expect(auditCalls).toHaveLength(1);
    expect(notifyCalls).toHaveLength(2);
    expect(notifyCalls[0]).toMatchObject({ template_id: "persona_addendum_suspended" });
  });

  it("fail with no active owners: still suspends + audits", async () => {
    const { db, updates } = makeDb({ owners: [] });
    const res = await applyRescreenResult({
      db,
      tenant_id: TENANT,
      addendum_id: ADDENDUM,
      persona_slug: SLUG,
      result_text: '{"pass": false, "findings": [{"category": "x", "evidence": "y"}]}',
    });
    expect(res.status).toBe("suspended");
    expect(updates).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
    expect(notifyCalls).toHaveLength(0);
  });

  it("fail-closed on unparseable response: suspends with parse_error finding", async () => {
    const { db, updates } = makeDb({ owners: [{ email: "owner@example.com" }] });
    const res = await applyRescreenResult({
      db,
      tenant_id: TENANT,
      addendum_id: ADDENDUM,
      persona_slug: SLUG,
      result_text: "the model returned prose only",
    });
    expect(res.status).toBe("suspended");
    expect(res.findings_count).toBeGreaterThan(0);
    expect(updates[0]).toMatchObject({ status: "suspended" });
    expect(notifyCalls).toHaveLength(1);
  });
});
