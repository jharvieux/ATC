"use client";

// §9, §16.6 — Tenant persona overrides + addendum editor.
//
// Lists the six base personas. For each, the tenant can:
//   - rename (display_name_override)
//   - disable (is_disabled)
//   - attach a written addendum (Pro / Agency / Enterprise tiers only — server enforces)
//
// Addendums go through Haiku screening (§16.6). UI surfaces status:
//   pending_screen / approved / rejected.

import React, { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const TEXT_INPUT_CLS =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

interface PersonaRow {
  slug: string;
  display_name: string;
  specialty: string;
  tagline: string;
  is_disabled: boolean;
  has_custom_addendum: boolean;
}

interface AddendumRow {
  id: string;
  content: string;
  status: "pending_screen" | "approved" | "rejected";
  haiku_screen_result: { reason?: string } | null;
  haiku_screened_at: string | null;
  updated_at: string;
}

export default function PersonasPage() {
  const [personas, setPersonas] = useState<PersonaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tenant/personas");
        if (!res.ok) throw new Error(`load_failed_${res.status}`);
        const data = (await res.json()) as { personas: PersonaRow[] };
        if (!cancelled) {
          setPersonas(data.personas);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "load_failed");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function updatePersona(slug: string, patch: Partial<PersonaRow>) {
    setPersonas((rows) => rows.map((r) => (r.slug === slug ? { ...r, ...patch } : r)));
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-gray-500">Loading personas…</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-2">AI Personas</h1>
      <p className="text-gray-500 mb-8">
        Six built-in personas serve customers in different voices. Rename or disable any persona for
        your tenant. Pro and higher tiers can attach a written addendum that the AI will read
        alongside the base persona prompt.
      </p>

      {error && (
        <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {personas.map((p) => (
          <PersonaCard
            key={p.slug}
            persona={p}
            expanded={expanded === p.slug}
            onToggle={() => setExpanded(expanded === p.slug ? null : p.slug)}
            onUpdate={(patch) => updatePersona(p.slug, patch)}
          />
        ))}
      </div>
    </div>
  );
}

function PersonaCard({
  persona,
  expanded,
  onToggle,
  onUpdate,
}: {
  persona: PersonaRow;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<PersonaRow>) => void;
}) {
  const [displayName, setDisplayName] = useState(persona.display_name);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function saveDisplay() {
    setSaving(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/tenant/personas/${persona.slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name_override: displayName }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setRowError(d.error ?? "save_failed");
        return;
      }
      onUpdate({ display_name: displayName });
    } finally {
      setSaving(false);
    }
  }

  async function toggleDisabled(next: boolean) {
    setSaving(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/tenant/personas/${persona.slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_disabled: next }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setRowError(d.error ?? "save_failed");
        return;
      }
      onUpdate({ is_disabled: next });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {persona.display_name}
            {persona.is_disabled && (
              <span className="text-xs bg-gray-300 text-gray-700 px-2 py-0.5 rounded-full">
                Disabled
              </span>
            )}
            {persona.has_custom_addendum && (
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                Custom addendum
              </span>
            )}
          </CardTitle>
          <button
            type="button"
            className="text-sm text-blue-600 underline"
            onClick={onToggle}
          >
            {expanded ? "Hide" : "Edit"}
          </button>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          <strong>{persona.specialty}.</strong> {persona.tagline}
        </p>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4 border-t pt-4">
          {rowError && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
              {rowError}
            </div>
          )}

          <div className="flex items-end gap-3">
            <label className="flex-1">
              <span className="block text-sm font-medium text-gray-700 mb-1">Display name</span>
              <input
                type="text"
                className={TEXT_INPUT_CLS}
                value={displayName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)}
                placeholder={persona.display_name}
              />
            </label>
            <Button onClick={saveDisplay} disabled={saving || displayName === persona.display_name}>
              Save
            </Button>
          </div>

          <div className="flex items-center justify-between border-t pt-3">
            <div>
              <p className="font-medium text-sm">Disable this persona</p>
              <p className="text-xs text-gray-500">
                Customers will not see this persona as an option.
              </p>
            </div>
            <Switch
              checked={persona.is_disabled}
              onCheckedChange={(v) => void toggleDisabled(v)}
              disabled={saving}
              aria-label={`Disable ${persona.display_name}`}
            />
          </div>

          <AddendumEditor slug={persona.slug} onSaved={() => onUpdate({ has_custom_addendum: true })} />
        </CardContent>
      )}
    </Card>
  );
}

function AddendumEditor({ slug, onSaved }: { slug: string; onSaved: () => void }) {
  const [addendum, setAddendum] = useState<AddendumRow | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tierBlocked, setTierBlocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/tenant/personas/${slug}/addendum`);
        if (res.status === 403) {
          setTierBlocked(true);
          setLoading(false);
          return;
        }
        if (!res.ok) throw new Error(`load_failed_${res.status}`);
        const data = (await res.json()) as { addendum: AddendumRow | null };
        if (cancelled) return;
        setAddendum(data.addendum);
        setDraft(data.addendum?.content ?? "");
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "load_failed");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tenant/personas/${slug}/addendum`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      const data = (await res.json()) as { error?: string; status?: string };
      if (res.status === 403) {
        setTierBlocked(true);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "save_failed");
        return;
      }
      setAddendum({
        id: addendum?.id ?? "new",
        content: draft,
        status: "pending_screen",
        haiku_screen_result: null,
        haiku_screened_at: null,
        updated_at: new Date().toISOString(),
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500 border-t pt-3">Loading addendum…</p>;

  if (tierBlocked) {
    return (
      <div className="border-t pt-3">
        <p className="font-medium text-sm">Persona addendum</p>
        <p className="text-xs text-gray-500 mt-1">
          Adding a custom written addendum to a persona is available on Pro plan and above. Upgrade
          to give the AI extra guidance — your house style, preferred suppliers, things to avoid.
        </p>
      </div>
    );
  }

  const statusBadge = addendum ? (
    <span
      className={
        "text-xs px-2 py-0.5 rounded-full " +
        (addendum.status === "approved"
          ? "bg-green-100 text-green-700"
          : addendum.status === "rejected"
            ? "bg-red-100 text-red-700"
            : "bg-yellow-100 text-yellow-800")
      }
    >
      {addendum.status === "pending_screen" ? "Screening…" : addendum.status}
    </span>
  ) : null;

  return (
    <div className="border-t pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="font-medium text-sm">Persona addendum {statusBadge}</p>
        <span className="text-xs text-gray-500">{draft.length}/2000</span>
      </div>
      <p className="text-xs text-gray-500">
        Extra instructions the AI will read when speaking as this persona. Use plain language —
        &ldquo;always recommend X,&rdquo; &ldquo;never quote Y,&rdquo; &ldquo;for honeymooners, suggest Z.&rdquo; Submitted text is
        screened for safety before activation.
      </p>
      <textarea
        className="w-full rounded border border-gray-300 px-3 py-2 text-sm h-32"
        value={draft}
        maxLength={2000}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. House style: warm and chatty. Always recommend our preferred suppliers (Royal Caribbean, Celebrity, Princess). Never quote pricing without checking the live calendar."
      />
      {addendum?.status === "rejected" && addendum.haiku_screen_result?.reason && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
          Rejected by automated screen: {addendum.haiku_screen_result.reason}
        </div>
      )}
      {error && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-red-700 text-xs">{error}</div>
      )}
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving || draft.trim().length === 0 || draft === (addendum?.content ?? "")}>
          {saving ? "Submitting…" : "Submit for screening"}
        </Button>
      </div>
    </div>
  );
}
