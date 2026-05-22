"use client";

// §15.4 / §17.4 — Onboarding Stage 3: Legal acceptance.
// TODO(prompt-17): load documents from legal_documents table when §17 lands.

import { useState } from "react";
import { useRouter } from "next/navigation";

const DOCUMENT_TYPES = [
  { type: "tou",             label: "Terms of Use" },
  { type: "privacy_policy",  label: "Privacy Policy" },
  { type: "ai_disclaimer",   label: "AI Liability Disclaimer" },
  { type: "cookie_policy",   label: "Cookie Policy (US)" },
];

export default function OnboardingLegalPage() {
  const router = useRouter();
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggle = (type: string) =>
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });

  const allAccepted = DOCUMENT_TYPES.every((d) => accepted.has(d.type));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!allAccepted) return;

    setSubmitting(true);
    setError(null);

    const res = await fetch("/api/onboarding/legal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted_types: Array.from(accepted) }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Submission failed");
      setSubmitting(false);
      return;
    }

    router.push("/onboarding/ica");
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-4">Legal Documents</h1>
      <p className="text-sm text-gray-600 mb-6">
        Please review and accept each document to continue.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        {DOCUMENT_TYPES.map((doc) => (
          <label key={doc.type} className="flex items-start gap-3 border rounded p-4 cursor-pointer">
            <input
              type="checkbox"
              checked={accepted.has(doc.type)}
              onChange={() => toggle(doc.type)}
              className="mt-1"
            />
            <div>
              <p className="font-medium">{doc.label}</p>
              {/* TODO(prompt-17): render document content from legal_documents table */}
              <p className="text-xs text-gray-500 mt-1">
                [Document content placeholder — TODO(prompt-17): load from legal_documents table]
              </p>
            </div>
          </label>
        ))}

        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !allAccepted}
          className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "I Accept All — Continue"}
        </button>
      </form>
    </div>
  );
}
