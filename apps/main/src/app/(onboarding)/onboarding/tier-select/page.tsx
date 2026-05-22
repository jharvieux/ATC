"use client";

// §15.8 — Onboarding Stage 7: Tier selection with seat picker.
// Pricing preview from /api/pricing/preview.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type Tier = "starter" | "pro" | "agency";
type Period = "monthly" | "annual";

const TIER_LABELS: Record<Tier, string> = {
  starter: "Starter",
  pro: "Pro",
  agency: "Agency",
};

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  starter: "For solo agents just getting started.",
  pro: "For growing agencies with a small team.",
  agency: "For larger operations with multiple advisors.",
};

export default function OnboardingTierSelectPage() {
  const router = useRouter();
  const [tier, setTier] = useState<Tier>("starter");
  const [period, setPeriod] = useState<Period>("monthly");
  const [seats, setSeats] = useState(1);
  const [preview, setPreview] = useState<{ total_cents: number; base_cents: number; additional_seat_cents: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ tier, billing_period: period, seats: String(seats) });
    fetch(`/api/pricing/preview?${params}`)
      .then((r) => r.json())
      .then(setPreview)
      .catch(() => {});
  }, [tier, period, seats]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const res = await fetch("/api/onboarding/tier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, billing_period: period, seat_count: seats }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Submission failed");
      setSubmitting(false);
      return;
    }

    router.push("/onboarding/subscription");
  }

  const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-2">Choose Your Plan</h1>
      <div className="flex gap-2 mb-6">
        <button
          type="button"
          onClick={() => setPeriod("monthly")}
          className={`px-4 py-2 rounded border ${period === "monthly" ? "bg-blue-600 text-white" : ""}`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setPeriod("annual")}
          className={`px-4 py-2 rounded border ${period === "annual" ? "bg-blue-600 text-white" : ""}`}
        >
          Annual <span className="text-xs">(Save 2 months)</span>
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-3">
          {(["starter", "pro", "agency"] as Tier[]).map((t) => (
            <label key={t} className={`flex items-start gap-3 border rounded p-4 cursor-pointer ${tier === t ? "border-blue-500 bg-blue-50" : ""}`}>
              <input type="radio" name="tier" value={t} checked={tier === t} onChange={() => { setTier(t); if (t !== "agency") setSeats(1); }} className="mt-1" />
              <div>
                <p className="font-medium">{TIER_LABELS[t]}</p>
                <p className="text-xs text-gray-500">{TIER_DESCRIPTIONS[t]}</p>
              </div>
            </label>
          ))}
        </div>

        {tier === "agency" && (
          <div>
            <label className="block text-sm font-medium mb-1">Number of Advisors *</label>
            <input
              type="number"
              min={1}
              value={seats}
              onChange={(e) => setSeats(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-28 border rounded px-3 py-2"
            />
          </div>
        )}

        {preview && (
          <div className="border rounded p-4 bg-gray-50">
            <p className="text-sm font-medium">Estimated {period === "annual" ? "annual" : "monthly"} price:</p>
            <p className="text-2xl font-bold mt-1">{formatPrice(preview.total_cents)}</p>
            {tier === "agency" && seats > 1 && (
              <p className="text-xs text-gray-500 mt-1">
                Base: {formatPrice(preview.base_cents)} + {seats - 1} additional seat{seats > 2 ? "s" : ""}: {formatPrice(preview.additional_seat_cents)}
              </p>
            )}
          </div>
        )}

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
