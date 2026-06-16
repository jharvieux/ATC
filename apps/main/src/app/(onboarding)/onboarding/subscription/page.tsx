"use client";

// §15.8 — Onboarding Stage 8: Stripe subscription setup via Checkout.
// Creates a Checkout session with a 30-day trial for all tenant types. BYO hosts
// self-activate at checkout; sub-hosts get trial_end re-set to NOW+30d at admin approval.

import { useState } from "react";

export default function OnboardingSubscriptionPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCheckout() {
    setLoading(true);
    setError(null);

    const res = await fetch("/api/onboarding/subscription/checkout", { method: "POST" });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.url) {
      const base = data.error ?? "Failed to create checkout session";
      // Surface the server correlation ref when present so support can trace
      // the exact log line instead of guessing from a bare "internal_error".
      setError(data.ref ? `${base} (ref: ${data.ref})` : base);
      setLoading(false);
      return;
    }

    window.location.href = data.url;
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-4">Set Up Billing</h1>
      <p className="text-sm text-gray-600 mb-6">
        You will be redirected to Stripe to securely add your payment method.
        No charge will be made until your application is approved and your
        30-day trial period ends.
      </p>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <button
        onClick={handleCheckout}
        disabled={loading}
        className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50"
      >
        {loading ? "Redirecting to Stripe…" : "Add Payment Method"}
      </button>
    </div>
  );
}
