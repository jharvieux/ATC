"use client";

// §11.6 — Transfer consent page.
// Shown after OAuth completion when an anonymous session is detected.
// The user chooses to keep their conversation history or start fresh.
//
// Notice text verbatim per §11.6.

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface MessagePreview {
  preview: string;
  created_at: string;
}

interface TransferPreviewData {
  message_count: number;
  time_span: { from: string; to: string } | null;
  message_previews: MessagePreview[];
  anonymous_session_id: string;
}

export default function TransferConsentPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const anonymousSessionId = searchParams.get("session");

  const [preview, setPreview] = useState<TransferPreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!anonymousSessionId) {
      router.replace("/");
      return;
    }

    fetch(`/api/auth/transfer-session/preview?session=${anonymousSessionId}`)
      .then((r) => r.json())
      .then((data: TransferPreviewData) => setPreview(data))
      .catch(() => setError("Unable to load session preview."))
      .finally(() => setLoading(false));
  }, [anonymousSessionId, router]);

  async function handleKeep() {
    if (!anonymousSessionId) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/transfer-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymous_session_id: anonymousSessionId, action: "commit" }),
      });
      if (!res.ok) throw new Error("Transfer failed");
      router.replace("/");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDiscard() {
    if (!anonymousSessionId) return;
    setSubmitting(true);
    try {
      await fetch("/api/auth/transfer-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymous_session_id: anonymousSessionId, action: "discard" }),
      });
      router.replace("/");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="p-8 text-center">Loading your session history…</div>;
  if (error) return <div className="p-8 text-center text-red-600">{error}</div>;
  if (!preview) return null;

  const fromDate = preview.time_span
    ? new Date(preview.time_span.from).toLocaleDateString()
    : null;
  const toDate = preview.time_span
    ? new Date(preview.time_span.to).toLocaleDateString()
    : null;

  return (
    <div className="max-w-lg mx-auto mt-16 p-8 rounded-lg border border-gray-200 shadow-sm">
      <h1 className="text-2xl font-semibold mb-4">Keep your conversation history?</h1>

      {/* §11.6 notice text verbatim */}
      <p className="text-gray-700 mb-6">
        You started a conversation before signing in. You can keep that history attached to your
        account, or start fresh. If you keep it, you have 24 hours to undo this decision from your
        settings.
      </p>

      {preview.message_count > 0 && (
        <div className="bg-gray-50 rounded-md p-4 mb-6">
          <p className="text-sm font-medium text-gray-600 mb-2">
            {preview.message_count} message{preview.message_count !== 1 ? "s" : ""}
            {fromDate && toDate ? ` · ${fromDate} – ${toDate}` : ""}
          </p>
          <ul className="space-y-1">
            {preview.message_previews.slice(0, 3).map((m, i) => (
              <li key={i} className="text-sm text-gray-500 truncate">
                {m.preview}
              </li>
            ))}
            {preview.message_count > 3 && (
              <li className="text-sm text-gray-400">
                + {preview.message_count - 3} more…
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={handleKeep}
          disabled={submitting}
          className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          Yes, keep it
        </button>
        <button
          onClick={handleDiscard}
          disabled={submitting}
          className="flex-1 bg-white text-gray-700 py-2 px-4 rounded-md font-medium border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        >
          No, start fresh
        </button>
      </div>
    </div>
  );
}
