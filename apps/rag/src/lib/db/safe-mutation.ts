// D-094 — Safe-mutation wrapper for Supabase JS v2.
//
// Supabase JS v2 returns `{ data, error }` and does NOT throw on DB errors.
// Discarding the result is the #1 most-recurring bug class in this codebase
// (Pattern 1 from the D-091 audit, present in 15/15 Greptile audits).
//
// This module provides ergonomic helpers that surface the error as a
// structured throw, so call sites can choose to:
//   a) Let the throw propagate (default — outer handlers turn it into 5xx)
//   b) Catch it for graceful degradation (best-effort writes)
//
// CALL-SITE STYLES (pick whichever reads best):
//
//   // Style 1: await + unwrap inline
//   const data = await safeAwait(
//     db.from("tenants").update({ status: "active" }).eq("id", id),
//     "tenants.update.status",
//   );
//
//   // Style 2: destructure-and-unwrap after-the-fact (when you need both)
//   const result = await db.from("tenants").update(...).eq("id", id).select();
//   const rows = unwrap(result, "tenants.update.status");
//
// The `context` argument is required and appears in the thrown error
// message + Sentry breadcrumbs. Use the form `<table>.<op>.<subject>`
// (e.g. `"payout_records.update.status_to_paid"`) so logs are greppable.

import type { PostgrestError } from "@supabase/supabase-js";

export class SupabaseMutationError extends Error {
  readonly code: string | null;
  readonly hint: string | null;
  readonly details: string | null;
  readonly context: string;
  readonly pgError: PostgrestError;

  constructor(context: string, pgError: PostgrestError) {
    super(`Supabase mutation failed [${context}]: ${pgError.message}`);
    this.name = "SupabaseMutationError";
    this.context = context;
    this.code = pgError.code ?? null;
    this.hint = pgError.hint ?? null;
    this.details = pgError.details ?? null;
    this.pgError = pgError;
  }
}

export interface SupabaseResult<T> {
  data: T | null;
  error: PostgrestError | null;
}

/**
 * Throws `SupabaseMutationError` if `error` is truthy. Returns `data`,
 * which may still be `null` for void-result queries (e.g. an UPDATE that
 * doesn't chain `.select()`).
 *
 * Use this when you already have the awaited result and want to assert
 * success before continuing.
 */
export function unwrap<T>(result: SupabaseResult<T>, context: string): T | null {
  if (result.error) {
    throw new SupabaseMutationError(context, result.error);
  }
  return result.data;
}

/**
 * Like `unwrap`, but asserts `data` is non-null. Use for queries where
 * you EXPECT a value (`.single()`, `.maybeSingle()` when you've verified
 * the row exists, `.select()` after a row-affecting mutation).
 */
export function unwrapRequired<T>(result: SupabaseResult<T>, context: string): T {
  const data = unwrap(result, context);
  if (data === null) {
    throw new SupabaseMutationError(context, {
      message: `Expected non-null data from ${context}; got null. The query succeeded but returned no row.`,
      code: "EMPTY_RESULT",
      hint: "If the row may legitimately be absent, use `unwrap()` instead and handle the null case explicitly.",
      details: null,
      name: "EmptyResult",
    } as unknown as PostgrestError);
  }
  return data;
}

/**
 * Await + unwrap in one call. Equivalent to `unwrap(await query, context)`.
 * Returns data which may be null. Use `safeAwaitRequired` when you need
 * a non-null value.
 */
export async function safeAwait<T>(
  query: PromiseLike<SupabaseResult<T>>,
  context: string,
): Promise<T | null> {
  const result = await query;
  return unwrap(result, context);
}

/**
 * Await + unwrap + non-null assertion. Throws if the query returned
 * `null` data — useful when the row must exist for the operation to
 * be meaningful.
 */
export async function safeAwaitRequired<T>(
  query: PromiseLike<SupabaseResult<T>>,
  context: string,
): Promise<T> {
  const result = await query;
  return unwrapRequired(result, context);
}

/**
 * Await + assert exactly N rows were affected. Use for CAS-style updates
 * where the query chains `.select("id")` and the expected affected count
 * is known.
 *
 * Throws `SupabaseMutationError` with code `ROW_COUNT_MISMATCH` if the
 * actual count differs.
 *
 *   await safeAwaitRowCount(
 *     db.from("payout_records")
 *       .update({ status: "processing" })
 *       .eq("id", id)
 *       .eq("status", "available")
 *       .select("id"),
 *     "payout_records.cas_lock",
 *     1,
 *   );
 */
export async function safeAwaitRowCount<T>(
  query: PromiseLike<SupabaseResult<T[]>>,
  context: string,
  expectedCount: number,
): Promise<T[]> {
  const result = await query;
  const data = unwrap(result, context) ?? [];
  if (data.length !== expectedCount) {
    throw new SupabaseMutationError(context, {
      message: `Expected ${expectedCount} row(s); got ${data.length}. CAS guard or constraint mismatch.`,
      code: "ROW_COUNT_MISMATCH",
      hint: "Caller intended exact-row-count assertion. If the row may legitimately not match, restructure to use `safeAwait` and handle the empty-array case.",
      details: null,
      name: "RowCountMismatch",
    } as unknown as PostgrestError);
  }
  return data;
}
