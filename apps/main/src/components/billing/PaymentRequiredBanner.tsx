// §15.16 — Persistent banner shown when the tenant is non-paying.
//
// Server component. Reads the x-payment-banner-state header set by
// middleware (apps/main/src/middleware.ts), so the banner appears across
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
  const background = isPastGrace ? "#7f1d1d" : "#ca8a04";
  const message = isPastGrace
    ? "Your account is past due. Update your billing to restore full access."
    : "Your latest payment failed. Update your billing within the grace period to avoid losing access to automated features.";

  return (
    <div
      role="alert"
      style={{
        background,
        color: "white",
        padding: "10px 16px",
        textAlign: "center",
        fontSize: 14,
        lineHeight: 1.4,
      }}
    >
      <span style={{ marginRight: 12 }}>{message}</span>
      <a
        href="/settings/billing"
        style={{
          color: "white",
          textDecoration: "underline",
          fontWeight: 600,
        }}
      >
        Update billing →
      </a>
    </div>
  );
}
