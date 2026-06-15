"use client";

// §15.9 — Onboarding Stage 9: Stripe Connect Express setup.
// Redirects to Stripe Connect onboarding (identity, bank account, address).
// account.updated webhook with payouts_enabled=true advances the stage.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingConnectPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // BYO hosts skip connect_setup — advance stage and redirect away immediately.
  const advanceByo = useCallback(async () => {
    const res = await fetch("/api/onboarding/byo/advance", { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      router.replace(data.redirect_to);
    }
  }, [router]);
  useEffect(() => { void advanceByo(); }, [advanceByo]);

  async function handleConnect() {
    setLoading(true);
    setError(null);

    const res = await fetch("/api/onboarding/connect/link", { method: "POST" });
    const data = await res.json();

    if (!res.ok || !data.url) {
      setError(data.error ?? "Failed to generate Stripe Connect link");
      setLoading(false);
      return;
    }

    window.location.href = data.url;
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-4">Set Up Payouts</h1>
      <p className="text-sm text-gray-600 mb-6">
        Connect your bank account through Stripe to receive commission payouts.
        You will complete identity verification as part of this step.
      </p>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <button
        onClick={handleConnect}
        disabled={loading}
        className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50"
      >
        {loading ? "Redirecting to Stripe…" : "Set Up Payouts with Stripe"}
      </button>
    </div>
  );
}
