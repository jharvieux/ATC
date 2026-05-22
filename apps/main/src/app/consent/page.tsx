"use client";

// §17.4 — Consent renewal page.
// Shown when a user has pending documents that need re-acceptance.
// The middleware (or layout) redirects here; this page is always accessible.

import { useState, useEffect } from "react";

interface PendingDoc {
  document_type: string;
  document_id_pending: string;
  flagged_at: string;
  content_markdown?: string;
  version?: number;
}

const TYPE_LABELS: Record<string, string> = {
  tou: "Terms of Use",
  privacy_policy: "Privacy Policy",
  ai_disclaimer: "AI Liability Disclaimer",
  cookie_policy: "Cookie Policy",
  ica_subhost: "Independent Contractor Agreement",
  can_spam_addendum: "CAN-SPAM Addendum",
  tcpa_addendum: "TCPA Addendum",
};

export default function ConsentPage() {
  const [pendingDocs, setPendingDocs] = useState<PendingDoc[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allDone, setAllDone] = useState(false);

  useEffect(() => {
    async function fetchPending() {
      try {
        const res = await fetch("/api/user/consent/pending");
        if (!res.ok) throw new Error("Failed to load pending documents.");
        const data = await res.json() as { pending: PendingDoc[] };
        setPendingDocs(data.pending ?? []);
        if ((data.pending ?? []).length === 0) setAllDone(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }
    fetchPending();
  }, []);

  async function acceptDoc(documentType: string) {
    setSubmitting(true);
    setError(null);
    try {
      const token = document.cookie
        .split("; ")
        .find((c) => c.startsWith("sb-access-token="))
        ?.split("=")[1];

      const res = await fetch("/api/user/consent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ document_type: documentType }),
      });

      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error ?? "Failed to accept document.");
      }

      const next = new Set(accepted);
      next.add(documentType);
      setAccepted(next);

      const remaining = pendingDocs.filter((d) => !next.has(d.document_type));
      if (remaining.length === 0) {
        setAllDone(true);
        // Redirect to the original destination or home.
        const params = new URLSearchParams(window.location.search);
        const returnTo = params.get("return_to") ?? "/";
        window.location.href = returnTo;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="p-8 text-center">Loading documents…</div>;

  if (allDone) {
    return (
      <div className="p-8 text-center">
        <h1 className="text-xl font-semibold mb-2">All done!</h1>
        <p className="text-gray-600">Redirecting you…</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-bold mb-2">Updated Legal Documents</h1>
      <p className="text-gray-600 mb-8">
        Some of our legal documents have been updated. Please review and accept the new versions to continue.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {pendingDocs
          .filter((d) => !accepted.has(d.document_type))
          .map((doc) => (
            <div key={doc.document_type} className="border rounded-lg p-6 bg-white shadow-sm">
              <h2 className="text-lg font-semibold mb-2">
                {TYPE_LABELS[doc.document_type] ?? doc.document_type}
                {doc.version ? ` (Version ${doc.version})` : ""}
              </h2>
              {doc.content_markdown && (
                <div className="mb-4 max-h-64 overflow-y-auto text-sm text-gray-700 whitespace-pre-wrap border rounded p-3 bg-gray-50">
                  {doc.content_markdown}
                </div>
              )}
              <button
                type="button"
                disabled={submitting}
                onClick={() => acceptDoc(doc.document_type)}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
              >
                I Accept
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}
