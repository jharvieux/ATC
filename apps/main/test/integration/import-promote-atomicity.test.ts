// DB integration tests — atomic import-promote RPC (#1712, folds in #1711)
// Spec refs: §34.5 / §34.7 (acceptance promotion)
//
// Proves the property that unit tests structurally cannot: that
// public.promote_import is ONE transaction, so the pre-#1712 crash window
// between an insert and its checkpoint — which could orphan a duplicate
// contact/booking on the null-key booking path (#1711) — no longer exists.
//
// The strongest available proxy for "a retry re-ran the writes" is genuine
// concurrency: fire K parallel promote calls at the SAME queue row, all racing
// the exact null-key inserts (email/phone null, provider_booking_ref null) that
// the old checkpoint approach failed to keep exactly-once. If the promote were
// not atomic + serialized, several callers would each insert → duplicate
// contacts/bookings/commissions (the double-payout vector). The assertion is
// therefore exactly-one-of-each regardless of K, plus the idempotent re-call.
//
// Requires a live DB. Gated on SUPABASE_DB_URL + service-role creds; runs as a
// nightly job, not on every PR (same idiom as chat-limit-concurrency.test.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const adminToken = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const haveSupabase = Boolean(supabaseUrl && adminToken && dbUrl);
const describeIf = haveSupabase ? describe : describe.skip;

const RUN_TAG = `promote-${randomUUID().slice(0, 8)}`;
const K = 10; // concurrent callers per race

const CLAIMABLE = ["pending_review", "pending_validation"];

interface Fixtures {
  admin: SupabaseClient;
  sql: ReturnType<typeof postgres>;
  tenantId: string;
}
let fx: Fixtures;

// All params the RPC takes. Booking path uses the #1711 null-key shape:
// contact email/phone null AND provider_booking_ref null → no DB dedup key, so
// only the transaction's atomicity can keep it exactly-once.
function promoteParams(queueRowId: string, tenantId: string) {
  return {
    p_queue_row_id: queueRowId,
    p_tenant_id: tenantId,
    p_claimable_statuses: CLAIMABLE,
    p_document_type: "booking_confirmation",
    p_import_path: "document",
    p_source_ref: "invoice.pdf",
    p_confidence: 0.9,
    p_raw_extracted_fields: { passenger_last_names: ["Smith"] },
    p_accepting_user_id: null,
    p_submitted_by_user_id: null,
    p_contact_first_name: "Smith",
    p_contact_last_name: null,
    p_contact_email: null,
    p_contact_phone: null,
    p_contact_source_ref: "document:invoice.pdf",
    p_contact_notes: "Imported booking: Carnival / Vista on 2026-09-01",
    p_is_booking: true,
    p_cruise_line: "Carnival",
    p_ship_name: "Vista",
    p_sailing_date: "2026-09-01",
    p_duration_nights: 7,
    p_departure_port: "Miami",
    p_cabin_category: "balcony",
    p_total_amount_cents: 500000,
    p_currency: "USD",
    p_provider_booking_ref: null,
    p_cruise_line_id: null,
    p_cruise_ship_id: null,
    p_commission_rate: 0.15,
    p_commission_rate_source: "doc_parsed",
  };
}

async function seedQueueRow(tenantId: string): Promise<string> {
  const [row] = await fx.sql<{ id: string }[]>`
    INSERT INTO public.import_queue (tenant_id, import_path, source_ref, status, document_type)
    VALUES (${tenantId}, 'document', ${`invoice-${randomUUID().slice(0, 8)}.pdf`}, 'pending_review', 'booking_confirmation')
    RETURNING id
  `;
  if (!row) throw new Error("queue row insert returned nothing");
  return row.id;
}

async function countChildren(tenantId: string) {
  const [c] = await fx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.contacts WHERE tenant_id = ${tenantId}`;
  const [b] = await fx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.bookings WHERE tenant_id = ${tenantId}`;
  const [cm] = await fx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.commissions WHERE tenant_id = ${tenantId}`;
  const [ci] = await fx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.contact_imports WHERE tenant_id = ${tenantId}`;
  return { contacts: c!.n, bookings: b!.n, commissions: cm!.n, contactImports: ci!.n };
}

describeIf("promote_import RPC atomicity (DB integration)", () => {
  beforeAll(async () => {
    const admin = createClient(supabaseUrl!, adminToken!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const sql = postgres(dbUrl!, { max: K + 2, idle_timeout: 20, onnotice: () => {} });

    const tier = await sql<{ id: string }[]>`SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1`;
    if (!tier[0]) throw new Error("tier_definitions not seeded — apply migrations first");

    const [tenantRow] = await sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES (${RUN_TAG}, ${`PromoteTest ${RUN_TAG}`}, 'PromoteTest LLC', 'byo_host', 'active', ${tier[0].id})
      RETURNING id
    `;
    if (!tenantRow) throw new Error("tenant insert returned no row");

    fx = { admin, sql, tenantId: tenantRow.id };
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    const { sql, tenantId } = fx;
    try {
      // FK order: import_queue references contacts/bookings; commissions
      // reference bookings; contact_imports cascades from contacts.
      await sql`DELETE FROM public.import_queue WHERE tenant_id = ${tenantId}`;
      await sql`DELETE FROM public.commissions WHERE tenant_id = ${tenantId}`;
      await sql`DELETE FROM public.bookings WHERE tenant_id = ${tenantId}`;
      await sql`DELETE FROM public.contact_imports WHERE tenant_id = ${tenantId}`;
      await sql`DELETE FROM public.contacts WHERE tenant_id = ${tenantId}`;
      await sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        await tx`DELETE FROM public.tenants WHERE id = ${tenantId}`;
      });
    } finally {
      await sql.end();
    }
  }, 60000);

  // ── Test 1: a fresh promote writes exactly one of each and lands 'accepted' ─
  it(
    "fresh booking promote: one contact/booking/commission, queue row accepted, gross = round(fare*rate)",
    async () => {
      const { admin, sql, tenantId } = fx;
      const queueRowId = await seedQueueRow(tenantId);
      const before = await countChildren(tenantId);

      const { data, error } = await admin.rpc("promote_import", promoteParams(queueRowId, tenantId));
      expect(error).toBeNull();
      const res = data as { status: string; contact_id: string; booking_id: string; commission_id: string };
      expect(res.status).toBe("promoted");
      expect(res.contact_id).toBeTruthy();
      expect(res.booking_id).toBeTruthy();
      expect(res.commission_id).toBeTruthy();

      const after = await countChildren(tenantId);
      expect(after.contacts - before.contacts).toBe(1);
      expect(after.bookings - before.bookings).toBe(1);
      expect(after.commissions - before.commissions).toBe(1);
      expect(after.contactImports - before.contactImports).toBe(1);

      const [queue] = await sql<{ status: string; promoted_contact_id: string; promoted_booking_id: string }[]>`
        SELECT status, promoted_contact_id, promoted_booking_id FROM public.import_queue WHERE id = ${queueRowId}
      `;
      expect(queue?.status).toBe("accepted");
      expect(queue?.promoted_contact_id).toBe(res.contact_id);
      expect(queue?.promoted_booking_id).toBe(res.booking_id);

      // gross_commission_cents is BIGINT; postgres-js returns int8 as a string
      // unless cast SQL-side (#1834 — unify on the ::int cast countChildren()
      // above already uses, rather than a JS-side Number() coercion).
      const [comm] = await sql<{ gross_commission_cents: number }[]>`
        SELECT gross_commission_cents::int AS gross_commission_cents FROM public.commissions WHERE id = ${res.commission_id}
      `;
      expect(comm?.gross_commission_cents).toBe(Math.round(500000 * 0.15)); // 75000
    },
    60000,
  );

  // ── Test 2: K concurrent promotes of ONE row → exactly one of each ─────────
  //
  // This is the #1711 proof. Every caller races the same null-key inserts. The
  // FOR UPDATE lock + single transaction means exactly one caller writes and the
  // rest observe status='accepted' and return the same ids — never a duplicate.
  // The pre-#1712 insert/checkpoint path could not guarantee this: a retry that
  // re-entered between insert and checkpoint re-inserted.
  it(
    "K concurrent promotes of the same row: exactly one writes, the rest return already_accepted with the same ids",
    async () => {
      const { admin, tenantId } = fx;
      const queueRowId = await seedQueueRow(tenantId);
      const before = await countChildren(tenantId);

      const params = promoteParams(queueRowId, tenantId);
      const results = await Promise.all(
        Array.from({ length: K }, async () => {
          const { data, error } = await admin.rpc("promote_import", params);
          if (error) throw new Error(`rpc failed: ${error.message}`);
          return data as { status: string; contact_id: string; booking_id: string };
        }),
      );

      const promoted = results.filter((r) => r.status === "promoted");
      const alreadyAccepted = results.filter((r) => r.status === "already_accepted");
      expect(promoted).toHaveLength(1);
      expect(alreadyAccepted).toHaveLength(K - 1);

      // Every caller resolves to the SAME contact + booking.
      const contactIds = new Set(results.map((r) => r.contact_id));
      const bookingIds = new Set(results.map((r) => r.booking_id));
      expect(contactIds.size).toBe(1);
      expect(bookingIds.size).toBe(1);

      // The defect this fix prevents: no duplicate rows despite K concurrent entries.
      const after = await countChildren(tenantId);
      expect(after.contacts - before.contacts).toBe(1);
      expect(after.bookings - before.bookings).toBe(1);
      expect(after.commissions - before.commissions).toBe(1);
      expect(after.contactImports - before.contactImports).toBe(1);
    },
    60000,
  );

  // ── Test 3: idempotent re-call after completion ───────────────────────────
  it(
    "re-calling promote on an accepted row returns already_accepted and writes nothing new",
    async () => {
      const { admin, tenantId } = fx;
      const queueRowId = await seedQueueRow(tenantId);
      const params = promoteParams(queueRowId, tenantId);

      const first = await admin.rpc("promote_import", params);
      expect(first.error).toBeNull();
      expect((first.data as { status: string }).status).toBe("promoted");
      const mid = await countChildren(tenantId);

      const second = await admin.rpc("promote_import", params);
      expect(second.error).toBeNull();
      const res2 = second.data as { status: string; contact_id: string; booking_id: string };
      expect(res2.status).toBe("already_accepted");
      expect(res2.contact_id).toBe((first.data as { contact_id: string }).contact_id);
      expect(res2.booking_id).toBe((first.data as { booking_id: string }).booking_id);

      const after = await countChildren(tenantId);
      expect(after).toEqual(mid); // no second write
    },
    60000,
  );
});
