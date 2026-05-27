// Shared scaffolding for error-injection tests (D-091 follow-up).
//
// Each handler test file uses three injection modes:
//   1. DB error injection — Supabase mutation returns `{ data: null, error }`.
//   2. Resource-unavailable injection — Stripe/Anthropic/Redis throws on connect.
//   3. Concurrent execution — fire the same handler twice in parallel.
//
// vi.mock is hoisted, so the per-file mock blocks live in the test files
// themselves. This module exports plain factories (no module-mock side
// effects) plus a documented behavior-object shape that test files import
// and wire into their vi.mock callbacks.
//
// See ./README.md for the canonical usage pattern.

import { vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────
// makeFailingDbClient — Supabase-shaped client that fails specified methods
// ─────────────────────────────────────────────────────────────────────

export type SupabaseErrorShape = { code?: string; message: string };

export interface FailingDbOptions {
  // Which mutation methods should return { data: null, error: ... }.
  // Empty array = nothing fails (happy path).
  fail?: Array<"insert" | "update" | "delete" | "upsert">;
  // Optional custom error object. Default = synthetic PostgrestError-like shape.
  error?: SupabaseErrorShape;
  // Optional select() result — by default returns { data: [], error: null }.
  // For tests that need a specific row to be "found" by select before the
  // mutation runs, pass a custom resolver.
  selectResult?: {
    data?: unknown;
    error?: SupabaseErrorShape | null;
  };
  // Optional row that maybeSingle/single returns. Lets a handler reach
  // its mutation branch even if its happy-path needs a found tenant/etc.
  singleRow?: unknown;
  // Test-side counter — increments per mutation call. Lets the test
  // assert "the handler actually attempted the mutation we're checking."
  callCount?: { value: number };
}

// Returns a Supabase-shaped object usable in place of a real client. The
// chainable interface supports the methods we actually use in handlers:
//   .from(table).insert(...) → { data | error }
//   .from(table).select(cols).eq(...).maybeSingle() → { data | error }
//   .from(table).select(cols).eq(...).single() → { data | error }
//   .from(table).select(cols).eq(...).then(...) → array result
//   .from(table).update(payload).eq(...) [.select(...)] → { data | error }
//   .from(table).delete().eq(...) → { data | error }
//   .from(table).upsert(payload) → { data | error }
//
// This intentionally covers the subset of Supabase JS that production
// handlers use today. Add to it as new patterns surface.
export function makeFailingDbClient(opts: FailingDbOptions = {}) {
  const fail = new Set(opts.fail ?? []);
  const err: SupabaseErrorShape = opts.error ?? { code: "PGRST500", message: "synthetic db error" };
  const counter = opts.callCount;

  const mutationResult = (kind: "insert" | "update" | "delete" | "upsert") => {
    if (counter) counter.value += 1;
    if (fail.has(kind)) return { data: null, error: err };
    return { data: opts.selectResult?.data ?? null, error: null };
  };

  const selectChain: Record<string, unknown> = {
    eq() { return selectChain; },
    in() { return selectChain; },
    gt() { return selectChain; },
    gte() { return selectChain; },
    lt() { return selectChain; },
    lte() { return selectChain; },
    not() { return selectChain; },
    order() { return selectChain; },
    limit() { return selectChain; },
    async maybeSingle() {
      return {
        data: opts.singleRow ?? null,
        error: opts.selectResult?.error ?? null,
      };
    },
    async single() {
      return {
        data: opts.singleRow ?? null,
        error: opts.selectResult?.error ?? null,
      };
    },
    then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
      return resolve({
        data: opts.selectResult?.data ?? [],
        error: opts.selectResult?.error ?? null,
      });
    },
  };

  // update().eq().select() returns rows-affected on CAS-style updates.
  // Our select() chain doubles as the post-update terminator.
  const updateChain: Record<string, unknown> = {
    eq() { return updateChain; },
    in() { return updateChain; },
    select() {
      return {
        eq() { return this; },
        in() { return this; },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          return resolve(mutationResult("update"));
        },
      };
    },
    then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
      return resolve(mutationResult("update"));
    },
  };

  return {
    from(_table: string) {
      void _table;
      return {
        select(_cols: string) {
          void _cols;
          return selectChain;
        },
        insert(_payload: unknown) {
          void _payload;
          const insertChain = {
            select() {
              return {
                single: async () => mutationResult("insert"),
                maybeSingle: async () => mutationResult("insert"),
              };
            },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              return resolve(mutationResult("insert"));
            },
          };
          return insertChain;
        },
        update(_payload: unknown) {
          void _payload;
          return updateChain;
        },
        delete() {
          return {
            eq() { return this; },
            in() { return this; },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              return resolve(mutationResult("delete"));
            },
          };
        },
        upsert(_payload: unknown) {
          void _payload;
          return {
            select() {
              return {
                single: async () => mutationResult("upsert"),
              };
            },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              return resolve(mutationResult("upsert"));
            },
          };
        },
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Stripe SDK mock helpers
// ─────────────────────────────────────────────────────────────────────

// A test-controlled Stripe webhook event. Use with vi.mock("stripe", ...)
// where the mocked constructEvent returns this object.
export interface MockStripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export function makeMockStripeEvent(
  type: string,
  data: Record<string, unknown>,
  id?: string,
): MockStripeEvent {
  return {
    id: id ?? `evt_test_${type}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    data: { object: data },
  };
}

// Builds a fake Stripe webhook Request. Signature is verified inside the
// handler by the mocked Stripe SDK, so the actual signature header value
// does not need to be valid HMAC.
export function makeMockStripeWebhookRequest(eventType: string): Request {
  return new Request("https://example.com/api/webhooks/stripe/platform", {
    method: "POST",
    headers: { "stripe-signature": "fake-signature" },
    body: JSON.stringify({ type: eventType }),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Inngest invocation helpers
// ─────────────────────────────────────────────────────────────────────

// Inngest functions are created via `inngest.createFunction({...}, async () => {...})`.
// The returned object exposes the inner handler under `.fn` for direct
// invocation in tests. (Inngest exposes this; the alternative is sending
// a fake event through the dev server which is too heavy for unit tests.)
//
// Usage:
//   import { payoutsExecuteTransfer } from "@/inngest/payouts-execute-transfer";
//   const result = await invokeInngestFunction(payoutsExecuteTransfer, { event: {...} });
type InngestLike = {
  // Inngest's runtime stores the user-supplied handler in different
  // properties across versions. We accept any shape that exposes a
  // callable handler under one of the known names.
  fn?: (...args: unknown[]) => Promise<unknown>;
  opts?: { fn?: (...args: unknown[]) => Promise<unknown> };
  // Test-only convention: handler authors can export the bare async
  // function alongside the wrapped Inngest function for direct testing.
};

export async function invokeInngestFunction(
  fn: InngestLike,
  args: { event?: Record<string, unknown>; step?: Record<string, unknown> } = {},
): Promise<unknown> {
  const handler = fn.fn ?? fn.opts?.fn;
  if (!handler) {
    throw new Error("invokeInngestFunction: handler not found — pass the inner async function directly");
  }
  return handler({
    event: args.event ?? { data: {} },
    step: args.step ?? makeNoopStep(),
  });
}

// Minimal step shim — Inngest steps default to passthrough invocation
// (the wrapped function executes inline, no checkpointing). Tests that
// don't care about step boundaries can use this directly.
export function makeNoopStep(): Record<string, unknown> {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sleep: async () => {},
    sleepUntil: async () => {},
    sendEvent: async () => {},
    waitForEvent: async () => null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Resource-unavailable injection (Stripe/Anthropic/Redis throw on connect)
// ─────────────────────────────────────────────────────────────────────

// vi.mock is hoisted, so the actual mocking lives in the test file. This
// helper exposes the canonical "throwing client" shapes test files import.
//
// Usage in a test file:
//   vi.mock("stripe", () => ({ default: makeThrowingStripeClass() }));
export function makeThrowingStripeClass(): unknown {
  return class ThrowingStripe {
    transfers = {
      create: () => Promise.reject(makeStripeConnectionError()),
    };
    webhooks = {
      constructEvent: () => {
        throw new Error("synthetic stripe SDK failure");
      },
    };
    accounts = {
      retrieve: () => Promise.reject(makeStripeConnectionError()),
      update: () => Promise.reject(makeStripeConnectionError()),
    };
    errors = {
      StripeError: class StripeError extends Error {},
      StripeConnectionError: class StripeConnectionError extends Error {},
    };
  };
}

export function makeStripeConnectionError(): Error {
  const e = new Error("Could not connect to Stripe");
  // The handler distinguishes connection errors by .type. Match that.
  (e as Error & { type?: string }).type = "StripeConnectionError";
  return e;
}

// Throwing fetch mock — for handlers that use fetch() to call external
// services (Apify, GitHub, Resend). Returns a vi-spied fn that rejects
// every call. Restore via vi.restoreAllMocks() in afterEach.
export function makeThrowingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.reject(new Error("synthetic fetch failure")));
}
