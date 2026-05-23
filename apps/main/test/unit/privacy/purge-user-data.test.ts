// §25.4 / §25.4a — purgeUserDataPerRetention orchestration tests.
//
// We model only the call patterns the purge function actually uses; the
// fake Supabase client returns canned responses keyed by (table, op).
// Anything more would require a real Supabase, which is a separate
// integration suite.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { purgeUserDataPerRetention } from "@/lib/privacy/purge-user-data";

interface CallLog {
  selects: Array<{ table: string }>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
  deletes: Array<{ table: string }>;
}

interface Scenario {
  bookings: Array<{ id: string }>;
  hasDispute: boolean;
  failForensicsInsert?: boolean;
  contactsAnonymized: Array<{ id: string; tenant_id: string }>;
  messagesNulled: number;
  quotesNarrativesNulled: number;
  bookingsNotesNulled: number;
  memoriesDeleted: number;
  conversationIds: string[];
}

function makeFake(scenario: Scenario, log: CallLog): SupabaseClient {
  // Minimal thenable — only the `await x` path is needed in these tests.
  // Typed as `unknown` so callers can `await` it without intersecting with
  // the strict PromiseLike<T> intersection that conflicts with our extra
  // single-arg overload.
  function thenable<T>(value: T): unknown {
    return { then: (cb: (v: T) => unknown) => cb(value) };
  }

  function selectResolver(table: string): { data: unknown; error: null } {
    log.selects.push({ table });
    switch (table) {
      case "bookings":
        return { data: scenario.bookings, error: null };
      case "commissions":
        return scenario.hasDispute
          ? { data: [{ id: "disputed-comm", dispute_status: "open", booking_id: scenario.bookings[0]?.id ?? "" }], error: null }
          : { data: [], error: null };
      case "conversations":
        return { data: scenario.conversationIds.map((id) => ({ id })), error: null };
      case "contacts":
        return { data: scenario.contactsAnonymized, error: null };
      case "messages":
        return { data: [], error: null };
      default:
        return { data: [], error: null };
    }
  }

  // The fake chain is the same object reused for every query — `eq`, `in`,
  // `not`, `gte`, `select` all return the chain. Terminal ops resolve.
  function makeChain(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = (_cols?: string) => chain;
    chain.eq = (_c: string, _v: unknown) => chain;
    chain.in = (_c: string, _v: unknown[]) => chain;
    chain.not = (_c: string, _op: string, _v: unknown) => chain;
    chain.gte = (_c: string, _v: unknown) => chain;
    chain.order = (_c: string, _opts?: unknown) => chain;
    chain.limit = (_n: number) => chain;

    chain.maybeSingle = () =>
      Promise.resolve({
        data: (selectResolver(table).data as unknown[])[0] ?? null,
        error: null,
      });
    chain.single = () =>
      Promise.resolve({
        data: scenario.failForensicsInsert && table === "forensics_log"
          ? null
          : { id: "inserted-id" },
        error: scenario.failForensicsInsert && table === "forensics_log"
          ? { message: "synthetic_forensics_failure" }
          : null,
      });
    chain.then = (cb: (v: unknown) => unknown) => cb(selectResolver(table));

    chain.update = (values: Record<string, unknown>) => {
      log.updates.push({ table, values });
      // Compute rows affected per scenario knobs.
      let affected: unknown[];
      if (table === "messages") {
        affected = Array.from({ length: scenario.messagesNulled }, (_, i) => ({ id: `m${i}` }));
      } else if (table === "quotes") {
        affected = Array.from({ length: scenario.quotesNarrativesNulled }, (_, i) => ({ id: `q${i}` }));
      } else if (table === "bookings" && "notes" in values) {
        affected = Array.from({ length: scenario.bookingsNotesNulled }, (_, i) => ({ id: `b${i}` }));
      } else if (table === "bookings" && "anonymized_customer_hash" in values) {
        affected = scenario.bookings;
      } else if (table === "commissions" && "anonymized_customer_hash" in values) {
        affected = scenario.bookings.map((b) => ({ id: `c-${b.id}` }));
      } else if (table === "contacts" && "anonymized_customer_hash" in values) {
        // contacts.notes affected rows preserve tenant_id so the lib can build affected_tenant_ids.
        affected = scenario.contactsAnonymized;
      } else if (table === "users") {
        affected = [{ id: "user-1" }];
      } else {
        affected = [];
      }
      const result = { data: affected, error: null };
      // The update chain supports .eq/.in/.not before .select() in this lib.
      const updateChain: Record<string, unknown> = {};
      updateChain.eq = () => updateChain;
      updateChain.in = () => updateChain;
      updateChain.not = () => updateChain;
      updateChain.select = () => thenable(result);
      updateChain.then = (cb: (v: unknown) => unknown) => cb(result);
      return updateChain;
    };

    chain.delete = () => {
      log.deletes.push({ table });
      const affected = table === "customer_memories"
        ? Array.from({ length: scenario.memoriesDeleted }, (_, i) => ({ id: `mem${i}` }))
        : [];
      const result = { data: affected, error: null };
      const delChain: Record<string, unknown> = {};
      delChain.eq = () => delChain;
      delChain.in = () => delChain;
      delChain.select = () => thenable(result);
      delChain.then = (cb: (v: unknown) => unknown) => cb(result);
      return delChain;
    };

    chain.insert = (values: Record<string, unknown>) => {
      log.inserts.push({ table, values });
      const failure = scenario.failForensicsInsert && table === "forensics_log";
      const result = {
        data: failure ? null : { id: "inserted-id" },
        error: failure ? { message: "synthetic_forensics_failure" } : null,
      };
      return {
        select: () => ({
          single: () => Promise.resolve(result),
        }),
        then: (cb: (v: unknown) => unknown) => cb(result),
      };
    };
    return chain;
  }
  return {
    from: (t: string) => makeChain(t),
  } as unknown as SupabaseClient;
}

describe("purgeUserDataPerRetention", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      PLATFORM_PEPPER: process.env.PLATFORM_PEPPER,
      FORENSICS_ENCRYPTION_KEY_CURRENT: process.env.FORENSICS_ENCRYPTION_KEY_CURRENT,
      FORENSICS_ENCRYPTION_KEY_ID_CURRENT: process.env.FORENSICS_ENCRYPTION_KEY_ID_CURRENT,
    };
    process.env.PLATFORM_PEPPER = "test-pepper";
    process.env.FORENSICS_ENCRYPTION_KEY_CURRENT = Buffer.alloc(32, 1).toString("base64");
    process.env.FORENSICS_ENCRYPTION_KEY_ID_CURRENT = "forensics-test";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    vi.restoreAllMocks();
  });

  function baseScenario(): Scenario {
    return {
      bookings: [{ id: "b1" }, { id: "b2" }, { id: "b3" }],
      hasDispute: false,
      contactsAnonymized: [
        { id: "ct1", tenant_id: "tenant-1" },
        { id: "ct2", tenant_id: "tenant-2" },
      ],
      messagesNulled: 5,
      quotesNarrativesNulled: 2,
      bookingsNotesNulled: 0,
      memoriesDeleted: 1,
      conversationIds: ["conv-1"],
    };
  }

  it("counts every category on the happy path (no dispute)", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.purge_outcome).toBe("success");
    expect(result.counts.category_1_messages_nulled).toBe(5);
    expect(result.counts.category_2_narratives_nulled).toBe(2);
    expect(result.counts.category_2_memories_deleted).toBe(1);
    expect(result.counts.category_3_notes_anonymized).toBe(2);
    expect(result.counts.bookings_anonymized).toBe(3);
    expect(result.affected_tenant_ids.sort()).toEqual(["tenant-1", "tenant-2"]);
    expect(result.forensics_snapshot_id).toBeNull();
  });

  it("captures forensics snapshot when a commission dispute is open", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const scenario = { ...baseScenario(), hasDispute: true };
    const db = makeFake(scenario, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.purge_outcome).toBe("success");
    expect(result.forensics_snapshot_id).toBe("inserted-id");
    expect(result.forensics_snapshot_reason).toBe("commission_dispute");
    expect(log.inserts.find((i) => i.table === "forensics_log")).toBeDefined();
  });

  it("does NOT capture forensics when there is no open dispute", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.forensics_snapshot_id).toBeNull();
    expect(log.inserts.find((i) => i.table === "forensics_log")).toBeUndefined();
  });

  it("aborts when forensics insert fails (no Category 1-3 changes)", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const scenario = { ...baseScenario(), hasDispute: true, failForensicsInsert: true };
    const db = makeFake(scenario, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.purge_outcome).toBe("error");
    expect(result.error_detail).toMatch(/forensics_capture_failed/);
    // No update calls should have happened on messages/quotes/customer_memories/contacts/users/bookings/commissions.
    const updatedTables = log.updates.map((u) => u.table);
    expect(updatedTables).not.toContain("messages");
    expect(updatedTables).not.toContain("quotes");
    expect(updatedTables).not.toContain("contacts");
    expect(updatedTables).not.toContain("bookings");
    expect(updatedTables).not.toContain("commissions");
    expect(updatedTables).not.toContain("users");
    // No customer_memories delete.
    expect(log.deletes.find((d) => d.table === "customer_memories")).toBeUndefined();
    // ccpa_deletion_executions row IS written (error outcome).
    const audit = log.inserts.find((i) => i.table === "ccpa_deletion_executions");
    expect(audit).toBeDefined();
    expect((audit?.values as { purge_outcome: string }).purge_outcome).toBe("error");
  });
});
