"use client";

// §11.6 — Persistent undo banner for the 24-hour transfer window.
// Rendered at the top of /settings/conversations when the current user has
// an anonymous_session row with transfer_soft_commit_at set and
// transfer_committed_at not yet set.
//
// Banner text per §11.6 verbatim, with countdown showing hours remaining.
// "Undo this transfer" calls the undoTransfer API endpoint.
// After 24h: replaced with "Transfer made permanent on [DateTime]".

import { useState, useEffect } from "react";

interface UndoBannerProps {
  anonymousSessionId: string;
  transferSoftCommitAt: string;
  transferCommittedAt: string | null;
}

export function UndoBanner({
  anonymousSessionId,
  transferSoftCommitAt,
  transferCommittedAt,
}: UndoBannerProps) {
  const [hoursRemaining, setHoursRemaining] = useState<number | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function computeHours() {
      const commitMs = new Date(transferSoftCommitAt).getTime();
      const expiresMs = commitMs + 24 * 60 * 60 * 1000;
      const remaining = (expiresMs - Date.now()) / (60 * 60 * 1000);
      setHoursRemaining(Math.max(0, remaining));
    }

    computeHours();
    const interval = setInterval(computeHours, 60_000);
    return () => clearInterval(interval);
  }, [transferSoftCommitAt]);

  // Transfer already finalized — show permanent confirmation.
  if (transferCommittedAt) {
    const committedDate = new Date(transferCommittedAt).toLocaleString();
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-md px-4 py-3 text-sm text-gray-600">
        Transfer made permanent on {committedDate}.
      </div>
    );
  }

  // Transfer was undone.
  if (undone) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-md px-4 py-3 text-sm text-green-700">
        Transfer undone. Your conversation history has been removed from your account.
      </div>
    );
  }

  // Expired window — finalize event has fired; show static message until page refreshes.
  if (hoursRemaining !== null && hoursRemaining <= 0) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-md px-4 py-3 text-sm text-gray-600">
        Your conversation history transfer is being finalized.
      </div>
    );
  }

  async function handleUndo() {
    setUndoing(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/transfer-session/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymous_session_id: anonymousSessionId }),
      });
      if (res.status === 409) {
        setError("This transfer has already been finalized and cannot be undone.");
        return;
      }
      if (!res.ok) throw new Error("Undo request failed");
      setUndone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setUndoing(false);
    }
  }

  const hoursDisplay =
    hoursRemaining !== null ? Math.ceil(hoursRemaining) : "—";

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-md px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-blue-800">
          {/* §11.6 verbatim banner text */}
          Your previous conversation history was attached to your account. You have{" "}
          <strong>{hoursDisplay} hour{hoursDisplay !== 1 ? "s" : ""}</strong> to undo this.
        </p>
        <button
          onClick={handleUndo}
          disabled={undoing}
          className="shrink-0 text-sm font-medium text-blue-700 underline hover:text-blue-900 disabled:opacity-50"
        >
          {undoing ? "Undoing…" : "Undo this transfer"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
