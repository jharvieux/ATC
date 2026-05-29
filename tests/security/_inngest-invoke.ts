// BP30 §30.8 — direct-invocation harness for Inngest handlers in tests.
//
// Inngest's production execution model (createFunction → serve → runtime)
// is overkill for assertion-level testing. This helper reaches into the
// InngestFunction instance, pulls out the handler closure, and invokes
// it with a synthetic `{ event, step }` context. Step primitives are
// pass-through stubs (sleep is a no-op; run executes the fn inline).
//
// Limitations (deliberate — the goal is shape testing, not runtime parity):
//   - step.sleep is a no-op; tests must not rely on real time passing.
//   - step.sleepUntil with a future wake time defers the run: the handler
//     stops there and invoke returns `{ deferred: true }`, mirroring Inngest's
//     suspend semantics. A past/now wake time is a no-op (the run continues).
//   - step.sendEvent collects events into the returned object so tests
//     can assert what would have been fired.
//   - Concurrency / retry semantics are NOT modelled.
//
// Tests using this helper run against the local atc_main_test DB via the
// Tier-2 fixture tenant. Any DB writes the handler makes are real.

import type { InngestFunction } from "inngest";

interface MockStep {
  sleep: (id: string, ms: unknown) => Promise<void>;
  sleepUntil: (id: string, time: unknown) => Promise<void>;
  run: <T>(id: string, fn: () => Promise<T> | T) => Promise<T>;
  sendEvent: (id: string, payload: unknown) => Promise<void>;
}

export interface InvokeResult<T = unknown> {
  result: T;
  /** Events the handler asked Inngest to send (via step.sendEvent). */
  enqueuedEvents: Array<{ id: string; payload: unknown }>;
}

// Thrown by the step.sleepUntil stub when the wake time is in the future, so
// invoke can halt the handler the way Inngest's runtime would instead of
// running post-sleep code that never executes in a single live invocation.
class InngestRunDeferred extends Error {
  constructor() {
    super("inngest run deferred at future sleepUntil");
    this.name = "InngestRunDeferred";
  }
}

/**
 * Invoke an Inngest function's handler with a synthetic event.
 * Uses private-field reflection on the InngestFunction instance —
 * acceptable for test code, would never be done in production.
 */
export async function invokeInngestHandler<T = unknown>(
  inngestFn: InngestFunction.Any,
  event: { name: string; data: Record<string, unknown> },
): Promise<InvokeResult<T>> {
  // The handler closure is stored as a private `fn` field. Reach in
  // explicitly — this is the documented escape hatch for tests since
  // Inngest doesn't ship a public test harness in v4.
  const handler = (inngestFn as unknown as { fn: (ctx: unknown) => Promise<T> }).fn;
  if (typeof handler !== "function") {
    throw new Error("invokeInngestHandler: instance has no callable .fn property");
  }

  const enqueuedEvents: Array<{ id: string; payload: unknown }> = [];
  const step: MockStep = {
    sleep: async () => undefined,
    sleepUntil: async (_id, time) => {
      const wakeMs =
        time instanceof Date ? time.getTime()
          : typeof time === "string" ? Date.parse(time)
            : typeof time === "number" ? time
              : NaN;
      if (Number.isFinite(wakeMs) && wakeMs > Date.now()) throw new InngestRunDeferred();
    },
    run: async <R>(_id: string, fn: () => Promise<R> | R) => fn(),
    sendEvent: async (id, payload) => { enqueuedEvents.push({ id, payload }); },
  };

  let result: T;
  try {
    result = await handler({
      event: {
        name: event.name,
        data: event.data,
        ts: Date.now(),
        id: `test-${Date.now()}`,
        user: {},
      },
      step,
      runId: `run-${Date.now()}`,
      attempt: 0,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });
  } catch (err) {
    if (err instanceof InngestRunDeferred) {
      return { result: { deferred: true } as unknown as T, enqueuedEvents };
    }
    throw err;
  }

  return { result, enqueuedEvents };
}
