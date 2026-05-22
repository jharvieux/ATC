"use client";

// §17.5 — Admin page for publishing new legal document versions.

import { useState, useEffect } from "react";

interface LegalDoc {
  id: string;
  document_type: string;
  version: number;
  summary_of_changes: string | null;
  effective_at: string;
  superseded_at: string | null;
  created_at: string;
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

const VALID_TYPES = Object.keys(TYPE_LABELS);

export default function AdminLegalDocsPage() {
  const [docs, setDocs] = useState<LegalDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [form, setForm] = useState({
    document_type: "tou",
    content_markdown: "",
    summary_of_changes: "",
    effective_at: "",
  });

  async function loadDocs() {
    try {
      const res = await fetch("/api/admin/legal-docs", {
        headers: { "x-admin-user-id": "admin" },
      });
      if (!res.ok) throw new Error("Failed to load documents.");
      const data = await res.json() as { documents: LegalDoc[] };
      setDocs(data.documents ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadDocs(); }, []);

  async function publishVersion(e: React.FormEvent) {
    e.preventDefault();
    setPublishing(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch("/api/admin/legal-docs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-user-id": "admin",
        },
        body: JSON.stringify({
          document_type: form.document_type,
          content_markdown: form.content_markdown,
          ...(form.summary_of_changes ? { summary_of_changes: form.summary_of_changes } : {}),
          ...(form.effective_at ? { effective_at: form.effective_at } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error ?? "Publish failed.");
      }

      const result = await res.json() as { version: number };
      setSuccessMsg(`Published version ${result.version} for ${TYPE_LABELS[form.document_type] ?? form.document_type}.`);
      setForm({ ...form, content_markdown: "", summary_of_changes: "" });
      await loadDocs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold mb-6">Legal Document Management</h1>

      {/* Publish form */}
      <div className="bg-white border rounded-lg p-6 mb-8 shadow-sm">
        <h2 className="text-lg font-semibold mb-4">Publish New Version</h2>
        <form onSubmit={publishVersion} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Document Type</label>
            <select
              value={form.document_type}
              onChange={(e) => setForm({ ...form, document_type: e.target.value })}
              className="w-full border rounded px-3 py-2 text-sm"
            >
              {VALID_TYPES.map((t) => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Content (Markdown)</label>
            <textarea
              value={form.content_markdown}
              onChange={(e) => setForm({ ...form, content_markdown: e.target.value })}
              rows={12}
              required
              className="w-full border rounded px-3 py-2 text-sm font-mono"
              placeholder="# Document Title&#10;&#10;Content here..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Summary of Changes</label>
            <input
              type="text"
              value={form.summary_of_changes}
              onChange={(e) => setForm({ ...form, summary_of_changes: e.target.value })}
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Brief description of what changed"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Effective Date (optional, defaults to now)
            </label>
            <input
              type="datetime-local"
              value={form.effective_at}
              onChange={(e) => setForm({ ...form, effective_at: e.target.value })}
              className="w-full border rounded px-3 py-2 text-sm"
            />
          </div>

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">{error}</div>
          )}
          {successMsg && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3">{successMsg}</div>
          )}

          <button
            type="submit"
            disabled={publishing}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {publishing ? "Publishing…" : "Publish Version"}
          </button>
        </form>
      </div>

      {/* Document version list */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Version History</h2>
        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="border px-3 py-2">Type</th>
                <th className="border px-3 py-2">Version</th>
                <th className="border px-3 py-2">Effective</th>
                <th className="border px-3 py-2">Status</th>
                <th className="border px-3 py-2">Summary</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className={doc.superseded_at ? "text-gray-400" : ""}>
                  <td className="border px-3 py-2">{TYPE_LABELS[doc.document_type] ?? doc.document_type}</td>
                  <td className="border px-3 py-2">v{doc.version}</td>
                  <td className="border px-3 py-2">
                    {new Date(doc.effective_at).toLocaleDateString()}
                  </td>
                  <td className="border px-3 py-2">
                    {doc.superseded_at ? (
                      <span className="text-gray-400">Superseded</span>
                    ) : (
                      <span className="text-green-600 font-medium">Current</span>
                    )}
                  </td>
                  <td className="border px-3 py-2 max-w-xs truncate">
                    {doc.summary_of_changes ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
