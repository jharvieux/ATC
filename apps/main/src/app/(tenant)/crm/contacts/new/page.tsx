"use client";

// BP35 §35.7.1 — Contact creation form with required source picker.
//
// The category dropdown is fed from /api/crm/attribution-categories.
// If a UTM pending cookie is present, the system records utm_parsed and
// the manual selection just adds metadata; if no cookie, the manual
// category becomes the first-touch source_origin='agent_set'.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Category = { id: string; category_label: string; display_order: number; is_active: boolean };

export default function ContactCreatePage(): JSX.Element {
  const router = useRouter();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [pipeline, setPipeline] = useState("lead");
  const [sourceCategory, setSourceCategory] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    const r = await fetch("/api/crm/attribution-categories");
    if (!r.ok) return;
    const data = (await r.json()) as { categories: Category[] };
    setCategories(data.categories ?? []);
  }, []);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const submit = async () => {
    if (!first && !last) {
      setError("First or last name required.");
      return;
    }
    if (!sourceCategory && !sourceLabel) {
      setError("Source is required (pick a category or enter a custom label).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        pipeline_stage_key: pipeline,
      };
      if (first) body.first_name = first;
      if (last) body.last_name = last;
      if (email) body.email = email;
      if (phone) body.phone = phone;
      if (sourceCategory) body.attribution_manual_category = sourceCategory;
      if (sourceLabel) body.attribution_manual_label = sourceLabel;
      else if (sourceCategory) body.attribution_manual_label = sourceCategory;

      const r = await fetch("/api/crm/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { id: string };
      router.push(`/crm/contacts/${data.id}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <a href="/crm/contacts" className="text-sm text-blue-600 hover:underline">
        ← Back to contacts
      </a>
      <h1 className="text-2xl font-semibold mt-2 mb-6">New contact</h1>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">First name</label>
          <input
            type="text"
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Last name</label>
          <input
            type="text"
            value={last}
            onChange={(e) => setLast(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Phone</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="mb-4">
        <label className="block text-sm text-gray-600 mb-1">Pipeline stage</label>
        <select
          value={pipeline}
          onChange={(e) => setPipeline(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="lead">Lead</option>
          <option value="qualified">Qualified</option>
          <option value="quote_sent">Quote Sent</option>
          <option value="quote_accepted">Quote Accepted</option>
          <option value="booked">Booked</option>
          <option value="sailed">Sailed</option>
          <option value="lost">Lost</option>
          <option value="post_trip_followup">Post-Trip Follow-up</option>
        </select>
      </div>

      <div className="border-t border-gray-200 pt-4 mb-4">
        <h2 className="text-sm font-semibold mb-2">Source (required)</h2>
        <p className="text-xs text-gray-500 mb-3">
          How did this contact find you? Captured for §35 attribution reports.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Category</label>
            <select
              value={sourceCategory}
              onChange={(e) => setSourceCategory(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
            >
              <option value="">— pick one —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.category_label}>
                  {c.category_label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Custom label (optional)</label>
            <input
              type="text"
              placeholder="e.g. trade show / networking event"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 mb-4">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create contact"}
        </button>
        <a href="/crm/contacts" className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50">
          Cancel
        </a>
      </div>
    </div>
  );
}
