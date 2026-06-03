// §15.16 — Persistent banner shown when the tenant is non-paying.
//
// Server component. Reads the x-payment-banner-state header set by
// the proxy (apps/main/src/proxy.ts), so the banner appears across
// the whole app without per-page wiring.
//
// Visibility:
//   ""             → no banner
//   "within_grace" → yellow banner with link to billing (still functional)
//   "past_grace"   → red banner (the page itself is the billing page or an
//                    exempt route; the redirect already fired for everything
//                    else)

import { headers } from "next/headers";

export async function PaymentRequiredBanner(): Promise<JSX.Element | null> {
  const h = await headers();
  const state = h.get("x-payment-banner-state");
  if (!state) return null;

  const isPastGrace = state === "past_grace";
  const message = isPastGrace
    ? "Your account is past due. Update your billing to restore full access."
    : "Your latest payment failed. Update your billing within the grace period to avoid losing access to automated features.";

  return (
    <div
      role="alert"
      className={`py-2.5 px-4 text-center text-[14px] leading-[1.4] text-white ${isPastGrace ? "bg-red-900" : "bg-yellow-600"}`}
    >
      <span className="mr-3">{message}</span>
      <a href="/settings/billing" className="text-white underline font-semibold">
        Update billing →
      </a>
    </div>
  );
}
