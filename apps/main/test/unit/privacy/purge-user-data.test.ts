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
  // Optional cross-op ordered trace ("select:contacts", "update:contacts", …)
  // for call-order assertions. Only populated when a test opts in by providing it.
  ordered?: string[];
  // Optional capture of every raw .or() filter string passed to an update
  // chain, so a test can assert on the produced DSL string directly instead
  // of only on round-tripping it back through the fake's own parser.
  orFilters?: string[];
}

// Model PostgREST `.or("from_email.ilike."<pat>",…")` parsing: split terms on
// top-level commas (a comma inside double quotes is a literal value byte, not a
// separator — #2038), strip the double-quote wrapper, reverse PostgREST's
// `\"`/`\\` unquote, then reverse the lib's LIKE escaping, then case-fold. This
// lets a test seed a mixed-case OR reserved-char from_email row and prove it
// still matches after the round trip.
function splitTopLevelTerms(orArg: string): string[] {
  const terms: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < orArg.length; i++) {
    const ch = orArg[i];
    if (inQuotes) {
      if (ch === "\\") {
        cur += ch + (orArg[++i] ?? "");
      } else if (ch === '"') {
        inQuotes = false;
        cur += ch;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      cur += ch;
    } else if (ch === ",") {
      terms.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) terms.push(cur);
  return terms;
}

function matchRowsByOrIlike(
  rows: Array<{ from_email: string }>,
  orArg: string | null,
): Array<{ from_email: string }> {
  if (!orArg) return [];
  const patterns = splitTopLevelTerms(orArg).map((term) => {
    let val = term.replace(/^from_email\.ilike\./, "");
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    return val
      .replace(/\\(["\\])/g, "$1") // PostgREST unquote: \" -> "  \\ -> \
      .replace(/\\([\\%_])/g, "$1") // LIKE un-escape:   \% -> %  \_ -> _  \\ -> \
      .toLowerCase();
  });
  return rows.filter((r) => patterns.includes(r.from_email.toLowerCase()));
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
  // Greptile P2 #13 — count of conversations rows whose user_id was nulled.
  // Typically equals conversationIds.length unless some were already detached.
  conversationsUserIdNulled?: number;
  // #2031/#2032/#2034 — reach beyond the user_id-keyed tables.
  userEmail?: string | null;
  lineItemsScrubbed?: number;
  inboundGmailScrubbed?: number;
  inboundEmailsScrubbed?: number;
  aiBatchScrubbed?: number;
  // #2032 — force the ai_batch caller_metadata scrub to error (retry-safety test).
  failAiBatchScrub?: boolean;
  // #2038 — force the inbound/line-item scrubs to error (retry-safety tests).
  failGmailScrub?: boolean;
  failInboundEmailsScrub?: boolean;
  failLineItemsScrub?: boolean;
  // #2031/#2034 — when set, the inbound-table updates match these rows against the
  // captured .or() ilike filter instead of returning a fixed count, so a test can
  // prove case-insensitive from_email matching.
  inboundGmailRows?: Array<{ from_email: string }>;
  inboundEmailRows?: Array<{ from_email: string }>;
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
    log.ordered?.push(`select:${table}`);
    switch (table) {
      case "users":
        // loadUserEmailAddresses → .select("email").eq("id").maybeSingle()
        return { data: [{ email: scenario.userEmail ?? null }], error: null };
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
      log.ordered?.push(`update:${table}`);
      // The inbound scrub applies a `.or(from_email.ilike…)` filter; capture it so
      // a filter-aware scenario can compute matches (default fallback: fixed count).
      let orArg: string | null = null;

      const resolveResult = (): { data: unknown; error: { message: string } | null } => {
        if (scenario.failAiBatchScrub && table === "ai_batch_requests") {
          return { data: null, error: { message: "synthetic_ai_batch_failure" } };
        }
        if (scenario.failGmailScrub && table === "gmail_inbound_messages") {
          return { data: null, error: { message: "synthetic_gmail_failure" } };
        }
        if (scenario.failInboundEmailsScrub && table === "inbound_emails") {
          return { data: null, error: { message: "synthetic_inbound_emails_failure" } };
        }
        if (scenario.failLineItemsScrub && table === "booking_line_items" && "item_details" in values) {
          return { data: null, error: { message: "synthetic_line_items_failure" } };
        }
        // Compute rows affected per scenario knobs.
        let affected: unknown[];
        if (table === "gmail_inbound_messages" && scenario.inboundGmailRows) {
          affected = matchRowsByOrIlike(scenario.inboundGmailRows, orArg);
        } else if (table === "inbound_emails" && scenario.inboundEmailRows) {
          affected = matchRowsByOrIlike(scenario.inboundEmailRows, orArg);
        } else if (table === "messages") {
          affected = Array.from({ length: scenario.messagesNulled }, (_, i) => ({ id: `m${i}` }));
        } else if (table === "conversations" && "user_id" in values && values.user_id === null) {
          // Greptile P2 #13 — conversations.user_id null pass.
          const n = scenario.conversationsUserIdNulled ?? scenario.conversationIds.length;
          affected = Array.from({ length: n }, (_, i) => ({ id: `cv${i}` }));
        } else if (table === "quotes") {
          affected = Array.from({ length: scenario.quotesNarrativesNulled }, (_, i) => ({ id: `q${i}` }));
        } else if (table === "bookings" && "notes" in values) {
          affected = Array.from({ length: scenario.bookingsNotesNulled }, (_, i) => ({ id: `b${i}` }));
        } else if (table === "bookings" && "anonymized_customer_hash" in values) {
          affected = scenario.bookings;
        } else if (table === "commissions" && "anonymized_customer_hash" in values) {
          affected = scenario.bookings.map((b) => ({ id: `c-${b.id}` }));
        } else if (table === "booking_line_items" && "item_details" in values) {
          affected = Array.from({ length: scenario.lineItemsScrubbed ?? 0 }, (_, i) => ({ id: `li${i}` }));
        } else if (table === "gmail_inbound_messages") {
          affected = Array.from({ length: scenario.inboundGmailScrubbed ?? 0 }, (_, i) => ({ id: `g${i}` }));
        } else if (table === "inbound_emails") {
          affected = Array.from({ length: scenario.inboundEmailsScrubbed ?? 0 }, (_, i) => ({ id: `ie${i}` }));
        } else if (table === "ai_batch_requests" && "caller_metadata" in values) {
          affected = Array.from({ length: scenario.aiBatchScrubbed ?? 0 }, (_, i) => ({ id: `bm${i}` }));
        } else if (table === "contacts" && "anonymized_customer_hash" in values) {
          // contacts.notes affected rows preserve tenant_id so the lib can build affected_tenant_ids.
          affected = scenario.contactsAnonymized;
        } else if (table === "users") {
          affected = [{ id: "user-1" }];
        } else {
          affected = [];
        }
        return { data: affected, error: null };
      };

      // The update chain supports .eq/.in/.not/.or before .select() in this lib.
      const updateChain: Record<string, unknown> = {};
      updateChain.eq = () => updateChain;
      updateChain.in = () => updateChain;
      updateChain.not = () => updateChain;
      updateChain.or = (arg: string) => {
        orArg = arg;
        log.orFilters?.push(arg);
        return updateChain;
      };
      updateChain.select = () => thenable(resolveResult());
      updateChain.then = (cb: (v: unknown) => unknown) => cb(resolveResult());
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
      userEmail: "jane@example.com",
      lineItemsScrubbed: 4,
      inboundGmailScrubbed: 3,
      inboundEmailsScrubbed: 2,
      aiBatchScrubbed: 5,
    };
  }

  it("counts every category on the happy path (no dispute)", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.purge_outcome).toBe("success");
    expect(result.counts.category_1_messages_nulled).toBe(5);
    // Greptile P2 #13 — conversations.user_id is also nulled (1 conv in scenario).
    expect(result.counts.category_1_conversations_user_id_nulled).toBe(1);
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

  // -- Pin the exact tables, columns, and status values written. -----------
  // These exist to kill StringLiteral mutations Stryker found in
  // purge-user-data.ts — any "table" / "column" / "status" string that flips
  // to "" or to a sibling string must produce a visible test failure.

  it("writes exactly these tables on the happy path", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    await purgeUserDataPerRetention(db, { user_id: "user-1" });

    const updateTables = log.updates.map((u) => u.table);
    expect(updateTables).toContain("messages");
    expect(updateTables).toContain("quotes");
    expect(updateTables).toContain("bookings");
    expect(updateTables).toContain("contacts");
    expect(updateTables).toContain("users");

    const deleteTables = log.deletes.map((d) => d.table);
    expect(deleteTables).toContain("customer_memories");

    const insertTables = log.inserts.map((i) => i.table);
    expect(insertTables).toContain("ccpa_deletion_executions");
  });

  it("nulls Category 1 (messages.content) — not some other column", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const msgUpdate = log.updates.find((u) => u.table === "messages");
    expect(msgUpdate).toBeDefined();
    expect(msgUpdate?.values).toHaveProperty("content");
    expect((msgUpdate?.values as { content: unknown }).content).toBeNull();
  });

  it("nulls Category 2 (quotes.narrative) — not some other column", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const quoteUpdate = log.updates.find((u) => u.table === "quotes");
    expect(quoteUpdate).toBeDefined();
    expect(quoteUpdate?.values).toHaveProperty("narrative");
    expect((quoteUpdate?.values as { narrative: unknown }).narrative).toBeNull();
  });

  it("Category 3 contacts: clears user_id + sets anonymized_customer_hash (text RETAINED per §25.4a)", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const contactUpdate = log.updates.find((u) => u.table === "contacts");
    expect(contactUpdate).toBeDefined();
    expect(contactUpdate?.values).toHaveProperty("user_id");
    expect((contactUpdate?.values as { user_id: unknown }).user_id).toBeNull();
    expect(contactUpdate?.values).toHaveProperty("anonymized_customer_hash");
    expect(typeof (contactUpdate?.values as { anonymized_customer_hash: unknown }).anonymized_customer_hash).toBe("string");
    // Per §25.4a, notes text is NOT nulled.
    expect(contactUpdate?.values).not.toHaveProperty("notes");
  });

  it("happy-path audit row has purge_outcome='success' (not the error string)", async () => {
    const log: CallLog = { selects: [], invests: [], inserts: [], updates: [], deletes: [] } as unknown as CallLog;
    const trueLog: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), trueLog);
    await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const audit = trueLog.inserts.find((i) => i.table === "ccpa_deletion_executions");
    expect(audit).toBeDefined();
    expect((audit?.values as { purge_outcome: string }).purge_outcome).toBe("success");
    void log;
  });

  it("forensics_snapshot_reason is exactly 'commission_dispute' on dispute path", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake({ ...baseScenario(), hasDispute: true }, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.forensics_snapshot_reason).toBe("commission_dispute");
  });

  it("audit row references the user_id passed in", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    await purgeUserDataPerRetention(db, { user_id: "user-42" });
    const audit = log.inserts.find((i) => i.table === "ccpa_deletion_executions");
    expect((audit?.values as { user_id: string }).user_id).toBe("user-42");
  });

  it("audit row records the grace_period_ended_at when supplied", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    const graceEnded = "2026-04-01T00:00:00.000Z";
    await purgeUserDataPerRetention(db, {
      user_id: "user-1",
      grace_period_ended_at: graceEnded,
    });
    const audit = log.inserts.find((i) => i.table === "ccpa_deletion_executions");
    expect(
      (audit?.values as { grace_period_ended_at: string }).grace_period_ended_at,
    ).toBe(graceEnded);
  });

  it("counts reflect every category in the audit row", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const audit = log.inserts.find((i) => i.table === "ccpa_deletion_executions");
    const v = audit?.values as Record<string, number>;
    expect(v.category_1_messages_nulled_count).toBe(5);
    expect(v.category_2_narratives_nulled_count).toBe(2);
    expect(v.category_2_memories_deleted_count).toBe(1);
    expect(v.category_3_notes_anonymized_count).toBe(2);
    expect(v.bookings_anonymized_count).toBe(3);
  });

  // #2034 — booking_line_items.item_details is free-form JSON with no user_id.
  // The purge must reach it via the user's bookings and null the blob, else
  // passenger PII survives behind an anonymized (FK-broken) booking.
  it("#2034 scrubs booking_line_items.item_details for the user's bookings", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const liUpdate = log.updates.find((u) => u.table === "booking_line_items");
    expect(liUpdate).toBeDefined();
    expect(liUpdate?.values).toHaveProperty("item_details");
    expect((liUpdate?.values as { item_details: unknown }).item_details).toBeNull();
    expect(result.counts.line_items_scrubbed).toBe(4);
  });

  // #2031 — inbound email content keys on the raw address, not user_id, so
  // booking/contact anonymization never reaches it. The purge must strip the
  // PII columns on both inbound tables for the user's addresses.
  it("#2031 scrubs inbound email content on both inbound tables", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });

    const gmail = log.updates.find((u) => u.table === "gmail_inbound_messages");
    expect(gmail).toBeDefined();
    // Nullable columns are nulled (raw_payload holds the full message).
    expect((gmail?.values as { raw_payload: unknown }).raw_payload).toBeNull();
    expect((gmail?.values as { from_email: unknown }).from_email).toBeNull();

    const inbound = log.updates.find((u) => u.table === "inbound_emails");
    expect(inbound).toBeDefined();
    // from_email/raw_payload are NOT NULL → redacted, not nulled.
    expect((inbound?.values as { from_email: unknown }).from_email).toBe("[erased]");
    expect((inbound?.values as { raw_payload: unknown }).raw_payload).toEqual({});
    expect((inbound?.values as { text_body: unknown }).text_body).toBeNull();

    expect(result.counts.inbound_gmail_scrubbed).toBe(3);
    expect(result.counts.inbound_emails_scrubbed).toBe(2);
  });

  it("#2031 does not scrub inbound content when the user has no known addresses", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake({ ...baseScenario(), userEmail: null }, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(log.updates.find((u) => u.table === "gmail_inbound_messages")).toBeUndefined();
    expect(log.updates.find((u) => u.table === "inbound_emails")).toBeUndefined();
    expect(result.counts.inbound_gmail_scrubbed).toBe(0);
    expect(result.counts.inbound_emails_scrubbed).toBe(0);
  });

  // #2032 — notif_preferences is exported by the data-export builder but was
  // never nulled by the purge; the users clear step must now include it.
  it("#2032 nulls users.notif_preferences in the PII-clear step", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const userUpdate = log.updates.find((u) => u.table === "users");
    expect(userUpdate).toBeDefined();
    expect(userUpdate?.values).toHaveProperty("notif_preferences");
    expect((userUpdate?.values as { notif_preferences: unknown }).notif_preferences).toBeNull();
  });

  // #2032 — a purged user's UUID persisted indefinitely in caller_metadata.
  it("#2032 nulls ai_batch_requests.caller_metadata for the purged user's rows", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake(baseScenario(), log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const bmUpdate = log.updates.find((u) => u.table === "ai_batch_requests");
    expect(bmUpdate).toBeDefined();
    expect((bmUpdate?.values as { caller_metadata: unknown }).caller_metadata).toBeNull();
    expect(result.counts.ai_batch_metadata_scrubbed).toBe(5);
  });

  // #2031 — external sender casing is arbitrary, so from_email matching must be
  // case-insensitive. An exact .in() misses a mixed-case stored variant (the row
  // then keeps the customer's PII past erasure). This pins that a mixed-case
  // variant IS scrubbed and an unrelated sender is left untouched — a regression
  // to case-sensitive .in() drops both counts to 0 and fails.
  it("#2031 scrubs a mixed-case from_email variant of the user's address (case-insensitive)", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const scenario: Scenario = {
      ...baseScenario(),
      userEmail: "jane@example.com",
      inboundGmailRows: [{ from_email: "Jane@Example.COM" }, { from_email: "someone-else@x.com" }],
      inboundEmailRows: [{ from_email: "JANE@example.com" }],
    };
    const db = makeFake(scenario, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.counts.inbound_gmail_scrubbed).toBe(1);
    expect(result.counts.inbound_emails_scrubbed).toBe(1);
  });

  // #2032 — the ai_batch caller_metadata scrub must run BEFORE the status='purged'
  // flip (the purge's idempotency guard). If the scrub fails, status must stay
  // unpurged so the caller's retry re-runs the whole purge (and the scrub). A
  // failure that landed AFTER the flip would be skipped forever by the caller.
  it("#2032 leaves status unpurged when the ai_batch scrub fails, so a retry re-runs it", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake({ ...baseScenario(), failAiBatchScrub: true }, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.purge_outcome).toBe("error");
    expect(result.error_detail).toMatch(/ai_batch_metadata_scrub_failed/);
    // The users PII-clear (which flips status='purged') must NOT have run.
    expect(log.updates.find((u) => u.table === "users")).toBeUndefined();
  });

  // #2038 — failure-injection on the inbound/line-item scrub throw-paths. Each
  // scrub runs BEFORE Step 8's status='purged' flip (the purge's idempotency
  // guard), so a throw must abort with outcome='error' and leave status
  // unpurged — otherwise the caller marks the purge done and the residual PII is
  // never re-scrubbed on retry. Mirrors the #2032 ai_batch retry-safety test.
  it("#2038 gmail_inbound scrub failure aborts before contacts detach / status flip", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake({ ...baseScenario(), failGmailScrub: true }, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.purge_outcome).toBe("error");
    expect(result.error_detail).toMatch(/inbound_gmail_scrub_failed/);
    // Step 4.5 fails → Step 5 (contacts detach) and Step 8 (users flip) never run.
    expect(log.updates.find((u) => u.table === "contacts")).toBeUndefined();
    expect(log.updates.find((u) => u.table === "users")).toBeUndefined();
  });

  it("#2038 inbound_emails scrub failure aborts before contacts detach / status flip", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake({ ...baseScenario(), failInboundEmailsScrub: true }, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.purge_outcome).toBe("error");
    expect(result.error_detail).toMatch(/inbound_emails_scrub_failed/);
    // The gmail scrub (first half of Step 4.5) DID run; the inbound_emails half throws.
    expect(log.updates.find((u) => u.table === "gmail_inbound_messages")).toBeDefined();
    expect(log.updates.find((u) => u.table === "contacts")).toBeUndefined();
    expect(log.updates.find((u) => u.table === "users")).toBeUndefined();
  });

  it("#2038 booking_line_items scrub failure aborts before the status flip", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const db = makeFake({ ...baseScenario(), failLineItemsScrub: true }, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.purge_outcome).toBe("error");
    expect(result.error_detail).toMatch(/line_items_scrub_failed/);
    // Step 6.5 fails → Step 7.7 (ai_batch) and Step 8 (users flip) never run.
    expect(log.updates.find((u) => u.table === "ai_batch_requests")).toBeUndefined();
    expect(log.updates.find((u) => u.table === "users")).toBeUndefined();
  });

  // #2038 — an address can carry PostgREST or()-grammar reserved chars
  // (`,` `(` `)`) in its local-part without being self-delimited by a literal
  // `"` (a value like `"a,b(c)"@example.com` is the wrong fixture for this:
  // its own leading/trailing `"` chars accidentally satisfy the fake's
  // quote-detection even if the production wrapper is deleted, so that
  // fixture can't actually catch a regression — see mutation-check note
  // below). Left unquoted by the production helper, the bare top-level comma
  // here would split the term and the paren would unbalance the group, so
  // this address only round-trips if `ilikeAnyFilter` really adds the `."…"`
  // DSL wrapper. Assert both the row-match outcome AND the raw filter string.
  it("#2038 scrubs an address whose local-part contains or()-grammar chars", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [], orFilters: [] };
    const weird = "a,b(c)@example.com";
    const scenario: Scenario = {
      ...baseScenario(),
      userEmail: weird,
      inboundGmailRows: [{ from_email: weird }, { from_email: "other@example.com" }],
      inboundEmailRows: [{ from_email: weird.toUpperCase() }],
    };
    const db = makeFake(scenario, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.counts.inbound_gmail_scrubbed).toBe(1);
    expect(result.counts.inbound_emails_scrubbed).toBe(1);
    // Direct check on the produced DSL string: the reserved-char value must be
    // wrapped in `."…"`, not left bare (which would malform the or() grammar).
    expect(log.orFilters![0]).toContain('.ilike."a,b(c)@example.com"');
  });

  // #2038/CodeQL alert 105 — a `\` needs BOTH the LIKE escape and the
  // PostgREST DSL escape (see the truth table on ilikeAnyFilter). Pin the
  // exact produced DSL string (one `\` -> four `\` on the wire) AND that the
  // fake's round-trip decode — the same `\"`/`\\` unquote then `\%`/`\_`/`\\`
  // LIKE un-escape PostgREST would perform — resolves back to the original
  // value, so a regression in the escape ordering fails both checks.
  it("#2038 scrubs an address whose local-part contains a literal backslash", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [], orFilters: [] };
    const weird = "a\\b@example.com";
    const scenario: Scenario = {
      ...baseScenario(),
      userEmail: weird,
      inboundGmailRows: [{ from_email: weird }, { from_email: "other@example.com" }],
      inboundEmailRows: [{ from_email: weird.toUpperCase() }],
    };
    const db = makeFake(scenario, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.counts.inbound_gmail_scrubbed).toBe(1);
    expect(result.counts.inbound_emails_scrubbed).toBe(1);
    expect(log.orFilters![0]).toContain('.ilike."a\\\\\\\\b@example.com"');
  });

  // #2031 — retry-safety: loadUserEmailAddresses reads contacts.user_id to collect
  // the user's addresses, and Step 5 nulls that FK. If the read ran AFTER the
  // detach, a retry would collect fewer addresses and the inbound scrub would miss
  // rows keyed on a contact's address. Pin that the read precedes the detach.
  it("loads the user's email addresses BEFORE detaching contacts (retry-safe ordering)", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [], ordered: [] };
    const db = makeFake(baseScenario(), log);
    await purgeUserDataPerRetention(db, { user_id: "user-1" });
    const ord = log.ordered!;
    const firstContactSelect = ord.indexOf("select:contacts");
    const firstContactDetach = ord.indexOf("update:contacts");
    expect(firstContactSelect).toBeGreaterThanOrEqual(0);
    expect(firstContactDetach).toBeGreaterThanOrEqual(0);
    expect(firstContactSelect).toBeLessThan(firstContactDetach);
  });

  it("returns affected_tenant_ids deduped from anonymized contacts", async () => {
    const log: CallLog = { selects: [], updates: [], inserts: [], deletes: [] };
    const scenario = {
      ...baseScenario(),
      contactsAnonymized: [
        { id: "ct1", tenant_id: "tenant-A" },
        { id: "ct2", tenant_id: "tenant-A" },
        { id: "ct3", tenant_id: "tenant-B" },
      ],
    };
    const db = makeFake(scenario, log);
    const result = await purgeUserDataPerRetention(db, { user_id: "user-1" });
    expect(result.affected_tenant_ids.sort()).toEqual(["tenant-A", "tenant-B"]);
  });
});
