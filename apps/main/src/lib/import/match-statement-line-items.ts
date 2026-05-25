// BP34 §34.5.4 / §14.8 — Commission-statement line-item matching.
//
// Inputs: a parsed commission_statement (from the extractor) and the
// tenant's existing commissions rows. Outputs: per-line-item match
// results, classified into auto-flow / admin-review / orphan buckets
// per the spec.
//
// Match strategy (§34.5.4):
//   1. Exact match on provider_booking_ref (preferred). Hits §14.8's
//      variance threshold path automatically.
//   2. Fuzzy match on (cruise_line, ship_name, sailing_date,
//      passenger_last_name) when ref is absent or doesn't match. Always
//      surfaces in admin review with confidence score — never
//      auto-accepted regardless of dollar variance.
//   3. Sub-0.60 confidence → orphan; admin can manually create an
//      imported booking from it or mark unmatched.
//
// This helper does the matching only. It does NOT write commission
// reconciliation rows — that's the §14.8 admin flow's job. We return a
// structured report so the caller can persist + surface in the admin UI.

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeMatchConfidence, type MatchOutcome } from "./match-confidence";
import type { CommissionStatementFields } from "./extractors/types";

export type LineItemMatch =
  | {
      kind: "exact_ref";
      line_index: number;
      provider_booking_ref: string;
      booking_id: string;
      commission_id: string;
      statement_amount_cents: number | null;
    }
  | {
      kind: "fuzzy";
      line_index: number;
      candidates: Array<{
        booking_id: string;
        commission_id: string;
        confidence: number;
        outcome: Extract<MatchOutcome, "high_confidence" | "possible">;
      }>;
      statement_amount_cents: number | null;
    }
  | {
      kind: "orphan";
      line_index: number;
      best_confidence: number; // < 0.60, kept for diagnostics
      statement_amount_cents: number | null;
    };

export type MatchReport = {
  tenant_id: string;
  total_lines: number;
  exact_ref_matches: number;
  fuzzy_matches: number;
  orphans: number;
  items: LineItemMatch[];
};

type CommissionRow = {
  id: string;
  booking_id: string;
  provider_booking_ref: string | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  passenger_last_name: string | null;
};

export async function matchStatementLineItems(args: {
  tenant_id: string;
  statement: CommissionStatementFields;
  svc: Pick<SupabaseClient, "from">;
}): Promise<MatchReport> {
  const { tenant_id, statement, svc } = args;
  const lines = statement.line_items;

  // Pull every commission row joined to the host booking metadata we
  // need for fuzzy matching. Bounded by the statement period when
  // available — keeps the candidate set sane on large tenants.
  const startBound = statement.statement_period_start ?? null;
  const endBound = statement.statement_period_end ?? null;

  let query = svc
    .from("commissions")
    .select(
      "id, booking_id, bookings!inner(provider_booking_ref, cruise_line, ship_name, sailing_date, primary_contact_id, contacts:primary_contact_id(last_name))",
    )
    .eq("tenant_id", tenant_id);

  if (startBound) query = query.gte("bookings.sailing_date", subtractMonths(startBound, 12));
  if (endBound) query = query.lte("bookings.sailing_date", addMonths(endBound, 6));

  const { data, error } = await query;
  if (error) throw new Error(`commissions_scan_failed: ${error.message}`);

  // Flatten the join shape into a flat lookup. Supabase typegen returns
  // joined rows as arrays (since !inner can technically yield multiple)
  // even when there's a 1:1 FK; we normalise to a single object here.
  type JoinedRow = {
    id: string;
    booking_id: string;
    bookings:
      | {
          provider_booking_ref: string | null;
          cruise_line: string | null;
          ship_name: string | null;
          sailing_date: string | null;
          contacts: { last_name: string | null } | { last_name: string | null }[] | null;
        }
      | Array<{
          provider_booking_ref: string | null;
          cruise_line: string | null;
          ship_name: string | null;
          sailing_date: string | null;
          contacts: { last_name: string | null } | { last_name: string | null }[] | null;
        }>
      | null;
  };
  const joinedRows = (data ?? []) as unknown as JoinedRow[];
  const candidates: CommissionRow[] = joinedRows
    .map((r) => {
      const b = Array.isArray(r.bookings) ? r.bookings[0] ?? null : r.bookings;
      if (!b) return null;
      const c = Array.isArray(b.contacts) ? b.contacts[0] ?? null : b.contacts;
      return {
        id: r.id,
        booking_id: r.booking_id,
        provider_booking_ref: b.provider_booking_ref,
        cruise_line: b.cruise_line,
        ship_name: b.ship_name,
        sailing_date: b.sailing_date,
        passenger_last_name: c?.last_name ?? null,
      } satisfies CommissionRow;
    })
    .filter((x): x is CommissionRow => x !== null);

  const refIndex = new Map<string, CommissionRow>();
  for (const c of candidates) {
    if (c.provider_booking_ref) refIndex.set(c.provider_booking_ref, c);
  }

  const items: LineItemMatch[] = [];
  let exact = 0;
  let fuzzy = 0;
  let orphans = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Step 1 — exact provider_booking_ref match.
    if (line.provider_booking_ref) {
      const hit = refIndex.get(line.provider_booking_ref);
      if (hit) {
        items.push({
          kind: "exact_ref",
          line_index: i,
          provider_booking_ref: line.provider_booking_ref,
          booking_id: hit.booking_id,
          commission_id: hit.id,
          statement_amount_cents: line.commission_amount_cents,
        });
        exact++;
        continue;
      }
    }

    // Step 2 — fuzzy match against all candidates.
    const fuzzyHits: Array<{ booking_id: string; commission_id: string; confidence: number; outcome: MatchOutcome }> = [];
    let best = 0;
    for (const c of candidates) {
      if (!c.cruise_line || !c.ship_name || !c.sailing_date || !c.passenger_last_name) continue;
      if (!line.cruise_line || !line.ship_name || !line.sailing_date || !line.passenger_last_name) continue;
      const res = computeMatchConfidence(
        {
          cruise_line: c.cruise_line,
          ship_name: c.ship_name,
          sailing_date: c.sailing_date,
          passenger_last_name: c.passenger_last_name,
        },
        {
          cruise_line: line.cruise_line,
          ship_name: line.ship_name,
          sailing_date: line.sailing_date,
          passenger_last_name: line.passenger_last_name,
        },
      );
      if (res.confidence > best) best = res.confidence;
      if (res.outcome === "high_confidence" || res.outcome === "possible") {
        fuzzyHits.push({
          booking_id: c.booking_id,
          commission_id: c.id,
          confidence: res.confidence,
          outcome: res.outcome,
        });
      }
    }
    if (fuzzyHits.length > 0) {
      fuzzyHits.sort((a, b) => b.confidence - a.confidence);
      items.push({
        kind: "fuzzy",
        line_index: i,
        candidates: fuzzyHits as Array<{
          booking_id: string;
          commission_id: string;
          confidence: number;
          outcome: Extract<MatchOutcome, "high_confidence" | "possible">;
        }>,
        statement_amount_cents: line.commission_amount_cents,
      });
      fuzzy++;
      continue;
    }

    items.push({
      kind: "orphan",
      line_index: i,
      best_confidence: best,
      statement_amount_cents: line.commission_amount_cents,
    });
    orphans++;
  }

  return {
    tenant_id,
    total_lines: lines.length,
    exact_ref_matches: exact,
    fuzzy_matches: fuzzy,
    orphans,
    items,
  };
}

function addMonths(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
function subtractMonths(iso: string, months: number): string {
  return addMonths(iso, -months);
}
