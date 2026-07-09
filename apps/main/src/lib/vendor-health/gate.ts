// BP26 §26.9 — vendor-health gating helper.
//
// Wraps an outbound vendor call so success/failure is fed into the
// vendor-health registry. The probe consumes the registry to surface
// degraded/down states; the chat route calls resolveVendorHealthStatus()
// before dispatching to skip the call when down.
//
// Usage:
//   const subscription = await withVendorHealthGate("stripe", () =>
//     stripe.subscriptions.retrieve(id),
//   );
//
// Failure-only-on-throw semantics. Caller is responsible for treating
// vendor-shaped error responses (non-throwing) as failures and recording
// via recordVendorFailure directly (see lib/email/send.ts for the pattern).

import { recordVendorFailure, recordVendorSuccess, type VendorName } from "./registry";

export async function withVendorHealthGate<T>(
  vendor: VendorName,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    recordVendorSuccess(vendor);
    return result;
  } catch (err) {
    recordVendorFailure(vendor, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
