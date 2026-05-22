"use client";

// §15.7 — Onboarding Stage 6: State of operation + compliance attestation.
// Phase 0/1 simplified. Phase 2 attorney gate (per-state STR) deferred.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const US_STATES = [
  ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],
  ["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],
  ["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],
  ["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],
  ["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],
  ["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],
  ["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],
  ["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],
  ["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],
  ["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],
  ["DC","District of Columbia"],
];

export default function OnboardingStateOfOperationPage() {
  const router = useRouter();
  const [state, setState] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [hostAgencyName, setHostAgencyName] = useState("[HOST AGENCY NAME]");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Load host agency name from platform_settings for the notice.
    fetch("/api/platform/settings/host-agency-name")
      .then((r) => r.json())
      .then((d) => { if (d.name) setHostAgencyName(d.name); })
      .catch(() => {}); // non-fatal
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !confirmed) return;

    setSubmitting(true);
    setError(null);

    const res = await fetch("/api/onboarding/state-of-operation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state_of_operation: state, confirmed_host_agency_notice: confirmed }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Submission failed");
      setSubmitting(false);
      return;
    }

    router.push("/onboarding/tier-select");
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-4">State of Operation</h1>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-medium mb-1">
            Primary state where you operate *
          </label>
          <select
            className="w-full border rounded px-3 py-2"
            value={state}
            onChange={(e) => setState(e.target.value)}
            required
          >
            <option value="">Select a state…</option>
            {US_STATES.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </div>

        <div className="border rounded p-4 bg-amber-50 text-sm">
          <p>
            Seller of Travel registration and E&amp;O insurance are handled at the
            host-agency level. By submitting, you confirm you understand this
            platform is operated by <strong>{hostAgencyName}</strong> as host of record.
          </p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" required />
          <span className="text-sm">I understand and confirm the above.</span>
        </label>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={submitting || !state || !confirmed}
          className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
