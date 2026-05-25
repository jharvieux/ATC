"use client";

// BP39 §39.7 — Agent edit panel for the trip resources page.

import { useCallback, useEffect, useState } from "react";

type LinkRow = { label: string; url: string; description?: string; source?: "auto" | "agent" };
type Section = { section_label: string; links: LinkRow[] };

type Resources = {
  id: string;
  access_token: string;
  status: "draft" | "published" | "archived";
  sections: Section[] | null;
  packing_checklist: string | null;
};

export function ResourcesEditor(props: { booking_id: string }): JSX.Element {
  const [res, setRes] = useState<Resources | null>(null);
  const [loading, setLoading] = useState(true);
  const [sections, setSections] = useState<Section[]>([]);
  const [packing, setPacking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/bookings/${props.booking_id}/resources`);
      if (!r.ok) return;
      const data = (await r.json()) as { resources: Resources | null };
      setRes(data.resources);
      setSections(data.resources?.sections ?? []);
      setPacking(data.resources?.packing_checklist ?? "");
    } finally {
      setLoading(false);
    }
  }, [props.booking_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/bookings/${props.booking_id}/resources`, { method: "POST" });
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { resources: Resources };
      setRes(data.resources);
      setSections(data.resources.sections ?? []);
    } finally {
      setBusy(false);
    }
  };

  const save = async (publish: boolean) => {
    if (!res) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/resources/${res.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections, packing_checklist: packing, publish }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as Resources;
      setRes(data);
    } finally {
      setBusy(false);
    }
  };

  const updateLink = (sIdx: number, lIdx: number, payload: Partial<LinkRow>) => {
    setSections((prev) => {
      const next = [...prev];
      const sec = { ...next[sIdx]! };
      const link = { ...sec.links[lIdx]!, ...payload, source: "agent" as const };
      sec.links = sec.links.map((l, i) => (i === lIdx ? link : l));
      next[sIdx] = sec;
      return next;
    });
  };

  const addLink = (sIdx: number) => {
    setSections((prev) => {
      const next = [...prev];
      const sec = { ...next[sIdx]! };
      sec.links = [...sec.links, { label: "", url: "", source: "agent" }];
      next[sIdx] = sec;
      return next;
    });
  };

  const removeLink = (sIdx: number, lIdx: number) => {
    setSections((prev) => {
      const next = [...prev];
      const sec = { ...next[sIdx]! };
      sec.links = sec.links.filter((_, i) => i !== lIdx);
      next[sIdx] = sec;
      return next;
    });
  };

  const publicUrl = res ? `${window.location.origin}/r/${res.access_token}` : "";

  if (loading) return <div className="text-sm text-gray-500">Loading resources…</div>;

  if (!res) {
    return (
      <div className="border border-dashed border-gray-300 rounded-md p-4 text-center">
        <p className="text-sm text-gray-600 mb-2">No resources page for this booking yet.</p>
        <button
          onClick={() => void generate()}
          disabled={busy}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          Generate resources page
        </button>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-md p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Trip resources</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full ${res.status === "published" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
          {res.status}
        </span>
      </div>

      {sections.map((sec, sIdx) => (
        <div key={sIdx} className="mb-3 border border-gray-200 rounded p-3 bg-gray-50">
          <div className="font-medium text-sm mb-2">{sec.section_label}</div>
          {sec.links.length === 0 && <div className="text-xs text-gray-400 mb-2">No links yet.</div>}
          {sec.links.map((link, lIdx) => (
            <div key={lIdx} className="flex gap-2 mb-2">
              <input
                type="text"
                placeholder="Label"
                value={link.label}
                onChange={(e) => updateLink(sIdx, lIdx, { label: e.target.value })}
                className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs"
              />
              <input
                type="url"
                placeholder="https://…"
                value={link.url}
                onChange={(e) => updateLink(sIdx, lIdx, { url: e.target.value })}
                className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs"
              />
              <button onClick={() => removeLink(sIdx, lIdx)} className="text-xs text-red-600">×</button>
            </div>
          ))}
          <button onClick={() => addLink(sIdx)} className="text-xs text-blue-600 hover:underline">
            + Add link
          </button>
        </div>
      ))}

      <label className="block text-xs text-gray-600 mb-1 mt-3">Packing checklist</label>
      <textarea
        value={packing}
        onChange={(e) => setPacking(e.target.value)}
        rows={6}
        className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3"
        placeholder="Things to pack…"
      />

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => void save(false)}
          disabled={busy}
          className="bg-white border border-gray-300 text-gray-700 px-3 py-1 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          Save draft
        </button>
        <button
          onClick={() => void save(true)}
          disabled={busy}
          className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {res.status === "published" ? "Save & update" : "Publish"}
        </button>
      </div>

      {res.status === "published" && (
        <div className="border-t border-gray-200 pt-3">
          <label className="block text-xs text-gray-600 mb-1">Customer link</label>
          <div className="flex gap-2 items-center">
            <input type="text" readOnly value={publicUrl} className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs font-mono" />
            <button
              onClick={() => {
                void navigator.clipboard.writeText(publicUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="bg-white border border-gray-300 text-gray-700 px-2 py-1 rounded text-xs hover:bg-gray-50"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
    </div>
  );
}
