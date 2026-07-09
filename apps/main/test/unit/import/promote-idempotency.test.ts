// BP34 §34.5 — promoteImport idempotency (#1576).
//
// The invariant under test: promotion produces EXACTLY ONE contact + booking +
// commission no matter how many times it is entered concurrently or retried.
// A duplicate commission row is the double-payout vector (payout idempotency is
// keyed per commission_id), so these tests fail if any of the three write
// families runs twice.
//
// Three vectors, matching the issue's failure modes:
//   1. Fresh promote writes one of each and lands the row in 'accepted'.
//   2. A second accept while the first still holds the CAS claim ('promoting')
//      must conflict WITHOUT writing (the double-click / two-agents case).
//   3. A crash after the commission insert, then a resumed retry, re-drives
//      from the checkpoints — no second contact/booking/commission.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: vi.fn(async () => ({ matched: false as const })),
}));
vi.mock("@/lib/import/resolve-commission-rate", () => ({
  resolveCommissionRate: vi.fn(async () => ({ rate: 0.15, source: "doc_parsed" })),
}));

import { promoteImport } from "@/lib/import/promote";

const TENANT_ID = "tenant-1";
const ROW_ID = "row-1";

type Row = Record<string, unknown>;

// Minimal stateful Supabase-shaped fake. Tracks inserts per table so the tests
// can assert exactly-once. import_queue is a single mutable row; its CAS claim,
// checkpoints, and finalize mutate it in place.
class FakeDB {
  queue: Row;
  contacts: Row[] = [];
  bookings: Row[] = [];
  commissions: Row[] = [];
  contactImports: Row[] = [];
  tenantType: string | null = "byo_host";
  failFinalizeOnce = false;
  private seq = 0;

  constructor(queue: Row) {
    this.queue = queue;
  }
  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  from(table: string) {
    return {
      select: (cols: string) => new QB(this, table, "select", { cols }),
      insert: (payload: Row) => new QB(this, table, "insert", { payload }),
      update: (payload: Row) => new QB(this, table, "update", { payload }),
    };
  }

  // Called by QB terminals.
  resolveSelect(table: string, filters: Filters): Row[] {
    const rows =
      table === "import_queue"
        ? [this.queue]
        : table === "tenants"
          ? [{ id: filters.eq.id, tenant_type: this.tenantType }]
          : table === "contacts"
            ? this.contacts
            : table === "bookings"
              ? this.bookings
              : table === "commissions"
                ? this.commissions
                : table === "contact_imports"
                  ? this.contactImports
                  : [];
    return rows.filter((r) =>
      Object.entries(filters.eq).every(([k, v]) => (r as Row)[k] === v),
    );
  }

  resolveInsert(table: string, payload: Row): { data: Row | null; error: null } {
    const store =
      table === "contacts"
        ? this.contacts
        : table === "bookings"
          ? this.bookings
          : table === "commissions"
            ? this.commissions
            : this.contactImports;
    const row = { id: this.id(table), ...payload };
    store.push(row);
    return { data: row, error: null };
  }

  resolveUpdate(table: string, payload: Row, filters: Filters): { data: Row[]; error: null } {
    if (table !== "import_queue") return { data: [], error: null };
    // CAS claim: .in("status", [...])
    if (filters.in && filters.in.column === "status") {
      if (!filters.in.values.includes(this.queue.status as string)) return { data: [], error: null };
      Object.assign(this.queue, payload);
      return { data: [this.queue], error: null };
    }
    // Guarded unclaim: .eq("status","promoting")
    if (filters.eq.status !== undefined && filters.eq.status !== this.queue.status) {
      return { data: [], error: null };
    }
    Object.assign(this.queue, payload);
    return { data: [this.queue], error: null };
  }
}

type Filters = {
  eq: Record<string, unknown>;
  in?: { column: string; values: unknown[] };
};

class QB implements PromiseLike<unknown> {
  private filters: Filters = { eq: {} };
  constructor(
    private db: FakeDB,
    private table: string,
    private op: "select" | "insert" | "update",
    private args: { cols?: string; payload?: Row },
  ) {}
  eq(k: string, v: unknown) {
    this.filters.eq[k] = v;
    return this;
  }
  in(k: string, v: unknown[]) {
    this.filters.in = { column: k, values: v };
    return this;
  }
  is() {
    return this;
  }
  not() {
    return this;
  }
  limit() {
    return this;
  }
  select() {
    return this;
  }
  async maybeSingle() {
    const rows = this.db.resolveSelect(this.table, this.filters);
    return { data: rows[0] ?? null, error: null };
  }
  async single() {
    if (this.op === "insert") return this.db.resolveInsert(this.table, this.args.payload ?? {});
    const rows = this.db.resolveSelect(this.table, this.filters);
    return { data: rows[0] ?? null, error: null };
  }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execThenable()).then(onfulfilled, onrejected);
  }
  private execThenable(): { data: unknown; error: unknown } {
    if (this.op === "select") return { data: this.db.resolveSelect(this.table, this.filters), error: null };
    if (this.op === "insert") return this.db.resolveInsert(this.table, this.args.payload ?? {});
    // update
    if (this.table === "import_queue" && this.db.failFinalizeOnce && "accepted_at" in (this.args.payload ?? {})) {
      this.db.failFinalizeOnce = false;
      return { data: null, error: { message: "connection reset", code: "57P01" } };
    }
    return this.db.resolveUpdate(this.table, this.args.payload ?? {}, this.filters);
  }
}

function bookingQueueRow(status: string, extra: Row = {}): Row {
  return {
    id: ROW_ID,
    tenant_id: TENANT_ID,
    import_path: "email",
    source_ref: "msg-1",
    document_type: "booking_confirmation",
    raw_extracted_fields: {
      passenger_last_names: ["Smith"],
      cruise_line: "Carnival",
      ship_name: "Vista",
      sailing_date: "2026-09-01",
      total_amount_cents: 500000,
      currency: "USD",
      provider_booking_ref: null,
    },
    extraction_overall_confidence: 0.9,
    submitted_by_user_id: null,
    status,
    promoted_contact_id: null,
    promoted_booking_id: null,
    ...extra,
  };
}

const svc = (db: FakeDB) => db as unknown as Parameters<typeof promoteImport>[0]["svc"];

beforeEach(() => vi.clearAllMocks());

describe("promoteImport — fresh promote writes exactly one of each (#1576)", () => {
  it("claims the row, writes contact+booking+commission, lands 'accepted'", async () => {
    const db = new FakeDB(bookingQueueRow("pending_review"));
    const result = await promoteImport({ queue_row_id: ROW_ID, svc: svc(db), acceptingUserId: "u1" });

    expect(result.ok).toBe(true);
    expect(db.contacts).toHaveLength(1);
    expect(db.bookings).toHaveLength(1);
    expect(db.commissions).toHaveLength(1);
    expect(db.queue.status).toBe("accepted");
  });
});

describe("promoteImport — concurrent accept conflicts without writing (#1576)", () => {
  it("returns promotion_in_progress and writes nothing when the row is already 'promoting'", async () => {
    // A concurrent execution already flipped the row to 'promoting'. The HTTP
    // accept path does not resume, so this second accept must conflict — the
    // double-click / two-agents vector that produced duplicate commissions.
    const db = new FakeDB(bookingQueueRow("promoting", { promoted_contact_id: "c-existing" }));
    const result = await promoteImport({ queue_row_id: ROW_ID, svc: svc(db), acceptingUserId: "u2" });

    expect(result).toEqual({ ok: false, error: "promotion_in_progress" });
    expect(db.contacts).toHaveLength(0);
    expect(db.bookings).toHaveLength(0);
    expect(db.commissions).toHaveLength(0);
  });
});

describe("promoteImport — resumed retry after a mid-sequence crash (#1576)", () => {
  it("re-drives from the checkpoints: still exactly one contact/booking/commission", async () => {
    const db = new FakeDB(bookingQueueRow("pending_review"));
    db.failFinalizeOnce = true; // throw once at finalize, AFTER all three inserts

    // Attempt 1 (Inngest auto-accept path): inserts land, finalize throws.
    await expect(
      promoteImport({ queue_row_id: ROW_ID, svc: svc(db), acceptingUserId: null, resumeInProgress: true }),
    ).rejects.toThrow(/connection reset/);

    // Checkpoints persisted; row is stuck 'promoting' (the throw skipped unclaim).
    expect(db.queue.status).toBe("promoting");
    expect(db.queue.promoted_contact_id).toBeTruthy();
    expect(db.queue.promoted_booking_id).toBeTruthy();
    expect(db.contacts).toHaveLength(1);
    expect(db.bookings).toHaveLength(1);
    expect(db.commissions).toHaveLength(1);

    // Attempt 2 (retry, same logical run): resumes and completes.
    const result = await promoteImport({
      queue_row_id: ROW_ID,
      svc: svc(db),
      acceptingUserId: null,
      resumeInProgress: true,
    });

    expect(result.ok).toBe(true);
    // The defect: no duplicate rows despite re-entry.
    expect(db.contacts).toHaveLength(1);
    expect(db.bookings).toHaveLength(1);
    expect(db.commissions).toHaveLength(1);
    expect(db.contactImports).toHaveLength(1);
    expect(db.queue.status).toBe("accepted");
  });
});

describe("promoteImport — second accept after completion is idempotent (#1576)", () => {
  it("returns the already-promoted records without writing again", async () => {
    const db = new FakeDB(
      bookingQueueRow("accepted", { promoted_contact_id: "c-done", promoted_booking_id: "b-done" }),
    );
    const result = await promoteImport({ queue_row_id: ROW_ID, svc: svc(db), acceptingUserId: "u3" });

    expect(result).toEqual({ ok: true, contact_id: "c-done", booking_id: "b-done" });
    expect(db.contacts).toHaveLength(0);
    expect(db.commissions).toHaveLength(0);
  });
});
