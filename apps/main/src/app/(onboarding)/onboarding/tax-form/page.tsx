"use client";

// §15.6 — Onboarding Stage 5: Tax form via Stripe Connect Express.
// This page shows a redirect spinner to Stripe's hosted W-9/W-8BEN flow.
// When Stripe fires account.updated with details_submitted=true, the webhook
// advances the stage automatically and the tenant is redirected to stage 6.

import { useEffect, useState } from "react";

export default function OnboardingTaxFormPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRedirectToStripe() {
    setLoading(true);
    setError(null);

    const res = await fetch("/api/onboarding/tax-form/stripe-link", { method: "POST" });
    const data = await res.json();

    if (!res.ok || !data.url) {
      setError(data.error ?? "Failed to generate Stripe link");
      setLoading(false);
      return;
    }

    window.location.href = data.url;
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-4">Tax Information</h1>
      <p className="text-sm text-gray-600 mb-6">
        We use Stripe to collect your W-9 or W-8BEN. You will be redirected to
        Stripe&apos;s secure hosted form. When complete, return here &mdash; your progress
        will be saved automatically.
      </p>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <button
        onClick={handleRedirectToStripe}
        disabled={loading}
        className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50"
      >
        {loading ? "Redirecting to Stripe…" : "Complete Tax Form with Stripe"}
      </button>

      <p className="text-xs text-gray-400 mt-4">
        Already submitted? Stripe will notify us automatically. You will be advanced
        to the next step shortly.
      </p>
    </div>
  );
}
