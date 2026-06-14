"use client";

// §15.5 — Onboarding Stage 4: ICA acceptance.
// Scroll-to-bottom gate via IntersectionObserver + typed legal name.
// OPERATOR CONFIRM placeholder: chunk-license-survival clause text is
// TODO(legal-attorney): final wording per §15.14.6.

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

// TODO(legal-attorney): replace placeholder text with final ICA per §15.14.6.
const ICA_CONTENT = `
# Independent Contractor Agreement

[ICA CONTENT PLACEHOLDER — TODO(legal-attorney): attorney to finalize language per §15.14.6]

## Chunk-License-Survival Clause

[CHUNK-LICENSE-SURVIVAL CLAUSE — TODO(legal-attorney): attorney to finalize perpetual, irrevocable
license language per §15.14.6 before Phase 2 onboarding opens.]

By signing below you agree to all terms and conditions set forth in this agreement.
`;

export default function OnboardingIcaPage() {
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // If the ICA content is shorter than the container (no scrollbar appears),
  // the onScroll handler never fires and the input stays permanently disabled.
  // Unlock immediately when content already fits.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 10) {
      setScrolledToBottom(true);
    }
  }, []);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
    if (atBottom) setScrolledToBottom(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!scrolledToBottom || !typedName.trim()) return;

    setSubmitting(true);
    setError(null);

    const res = await fetch("/api/onboarding/ica", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typed_legal_name: typedName, scrolled_to_bottom: scrolledToBottom }),
    });

    const data = await res.json();
    if (!res.ok) {
      const msg = data.error === "name_mismatch"
        ? "Name does not match your legal business name. Please type it exactly."
        : data.error ?? "Submission failed";
      setError(msg);
      setSubmitting(false);
      return;
    }

    router.push("/onboarding/tax-form");
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-4">Independent Contractor Agreement</h1>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="border rounded h-80 overflow-y-auto p-4 mb-4 bg-gray-50 text-sm whitespace-pre-wrap"
      >
        {ICA_CONTENT}
        <div ref={bottomRef} />
      </div>

      {!scrolledToBottom && (
        <p className="text-sm text-amber-600 mb-4">Please scroll to the bottom to enable acceptance.</p>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">
            Type your full legal business name to confirm *
          </label>
          <input
            className="w-full border rounded px-3 py-2"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            disabled={!scrolledToBottom}
            required
          />
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={submitting || !scrolledToBottom || !typedName.trim()}
          className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "I Agree — Continue"}
        </button>
      </form>
    </div>
  );
}
