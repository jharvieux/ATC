"use client";

// §15.10 — Onboarding Stage 10: Branding (optional/skippable).
// Full branding configuration is in Build Prompt 18.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingBrandingPage() {
  const router = useRouter();
  const [skipping, setSkipping] = useState(false);

  async function handleSkip() {
    setSkipping(true);
    const res = await fetch("/api/onboarding/branding-skip", { method: "POST" });
    if (!res.ok) {
      setSkipping(false);
      return;
    }
    const body = (await res.json()) as { next_stage?: string };
    // BYO hosts skip review and go straight to the dashboard; sub-hosts land
    // on the awaiting-review screen.
    router.push(
      body.next_stage === "complete" ? "/crm/contacts" : "/onboarding/review-submitted",
    );
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-4">Customize Your Brand</h1>
      <p className="text-sm text-gray-600 mb-6">
        You can upload your logo, set brand colors, and configure your display
        name. This step is optional — you can complete it later from your
        settings.
      </p>
      <p className="text-sm text-gray-400 mb-8">
        [Full branding controls — coming in a future update]
      </p>
      <button
        onClick={handleSkip}
        disabled={skipping}
        className="w-full border rounded py-2 text-gray-600 disabled:opacity-50"
      >
        {skipping ? "Continuing…" : "Skip for Now"}
      </button>
    </div>
  );
}
