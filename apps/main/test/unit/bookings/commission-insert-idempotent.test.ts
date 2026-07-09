// #1755 — pin the "pending_host_review manual resolution is insert-free" invariant.
//
// Race (post-#1751): the bookings-stuck-submitting-reconcile cron can win the
// race against POST /api/bookings/[id]/submit — it flips the row
// submitting → pending_host_review while the submit_commit_booking RPC (already
// running in its own transaction) still commits an 'expected' commission and
// its CAS status-flip matches 0 rows (route returns 409). The booking then
// sits in pending_host_review WITH a pre-existing 'expected' commission row.
//
// commissions carries UNIQUE(booking_id) (commissions_booking_id_uidx, #1575),
// so ANY later blind INSERT keyed on that booking_id would 23505. The manual
// resolution path an operator uses to clear pending_host_review must therefore
// never blind-insert a commission.
//
// Today that invariant holds structurally: commission INSERTs happen only in
// two DB-side paths — the submit_commit_booking RPC for host-submitted
// bookings (ON CONFLICT (booking_id) DO NOTHING), and promote_import for
// imported booking_confirmations (#1711, migration 20260722000006), which
// checks for an existing row before inserting. Both are independently
// idempotent via commissions_booking_id_uidx, and neither is reachable from
// PATCH or pending_host_review resolution. No app-layer code does
// `.from("commissions").insert(...)` at all — resolution is field-edit-only
// (patchable-fields.ts; the [id] PATCH route forbids status changes) plus hand
// reconciliation of the already-present row via update/waive paths.
//
// This test fails loudly if a future PR adds an app-layer commission insert to
// ANY path (a new "resolve review" route being the likely offender). If such a
// path is genuinely needed it must use `.upsert(..., { onConflict: "booking_id" })`
// or route through the RPC — not a bare `.insert()` that a lost-race 'expected'
// row would 23505.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(process.cwd(), "apps", "main", "src");

function* walkSourceFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const abs = join(root, entry);
    if (statSync(abs).isDirectory()) {
      yield* walkSourceFiles(abs);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      yield abs;
    }
  }
}

// Whitespace is collapsed first so a multi-line supabase chain
//   .from("commissions")
//     .insert({ ... })
// is caught the same as the single-line form. Both quote styles.
const BLIND_INSERT = /\.from\((["'])commissions\1\)\.insert\(/;

describe("#1755 — commissions are never blind-inserted from app code", () => {
  it("no app-layer path does .from(\"commissions\").insert( — the sole insert is the idempotent submit_commit_booking RPC", () => {
    const offenders: string[] = [];
    for (const absPath of walkSourceFiles(SRC_ROOT)) {
      const collapsed = readFileSync(absPath, "utf8").replace(/\s+/g, "");
      if (BLIND_INSERT.test(collapsed)) {
        offenders.push(absPath.slice(SRC_ROOT.length + 1));
      }
    }
    expect(
      offenders,
      "Blind commission insert(s) found — a pending_host_review lost-race 'expected' row " +
        "(commissions_booking_id_uidx, #1755) would 23505. Use .upsert({ onConflict: 'booking_id' }) " +
        "or the submit_commit_booking RPC:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
