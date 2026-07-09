"use client";

// #903 / D-193 — Voice profile settings.
// TAs paste email samples here; extraction runs automatically via Inngest.
// The extracted style card is shown as a summary the TA can override.

import { useCallback, useEffect, useState } from "react";
import { formatDate } from "@/lib/format-date";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface VoiceSample {
  id: string;
  body: string;
  source_label: string;
  created_at: string;
}

interface VoiceProfile {
  style_card: Record<string, unknown>;
  card_override: string | null;
  extracted_at: string | null;
}

interface ProfileData {
  own_samples: VoiceSample[];
  house_samples: VoiceSample[];
  profile: VoiceProfile | null;
  is_owner: boolean;
}

export default function VoiceProfilePage(): React.JSX.Element {
  const [data, setData] = useState<ProfileData | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // New-sample form
  const [newBody, setNewBody] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [isHouseStyle, setIsHouseStyle] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Card override form
  const [overrideText, setOverrideText] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);
  const [overrideStatus, setOverrideStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/voice-profiles/samples");
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { setLoadErr(`Load failed (HTTP ${res.status})`); return; }
      const d = (await res.json()) as ProfileData;
      setData(d);
      setOverrideText(d.profile?.card_override ?? "");
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addSample(): Promise<void> {
    const body = newBody.trim();
    if (body.length < 50) { setSaveErr("Paste at least 50 characters."); return; }
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch("/api/voice-profiles/samples", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, source_label: newLabel, is_house_style: isHouseStyle }),
      });
      if (!res.ok) {
        const e = (await res.json()) as { error?: string };
        setSaveErr(e.error ?? `HTTP ${res.status}`);
        return;
      }
      setNewBody(""); setNewLabel("");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function deleteSample(id: string): Promise<void> {
    const res = await fetch(`/api/voice-profiles/samples/${id}`, { method: "DELETE" });
    if (res.ok) await load();
  }

  async function saveOverride(): Promise<void> {
    setSavingOverride(true);
    setOverrideStatus(null);
    try {
      const res = await fetch("/api/voice-profiles/card", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ card_override: overrideText || null, is_house_style: isHouseStyle }),
      });
      setOverrideStatus(res.ok ? "Saved." : "Failed to save.");
    } finally {
      setSavingOverride(false);
    }
  }

  if (forbidden) return (
    <div className="p-8 max-w-lg mx-auto text-center mt-12">
      <p className="text-muted-foreground text-sm">Voice profiles are available to team members (Owner or Agent role).</p>
    </div>
  );
  if (loadErr) return <div className="p-8"><p className="text-red-700 dark:text-red-400 text-sm">{loadErr}</p></div>;
  if (!data) return <div className="p-8"><p className="text-muted-foreground text-sm">Loading…</p></div>;

  const card = data.profile;
  const cardSummary = card?.card_override || (
    card?.style_card && Object.keys(card.style_card).length > 0
      ? JSON.stringify(card.style_card, null, 2)
      : null
  );

  return (
    <main className="px-6 py-10 max-w-[760px] mx-auto">
      <h1 className="text-2xl font-bold mb-1">Voice Profile</h1>
      <p className="text-muted-foreground text-[14px] mb-8">
        Paste samples of your sent emails. The AI learns your writing style and will draft
        client replies in your voice.
      </p>

      {/* Extracted card */}
      <section className="mb-8">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Your writing style
          {card?.extracted_at && (
            <span className="ml-2 font-normal normal-case">
              — extracted {formatDate(card.extracted_at)}
            </span>
          )}
        </h2>
        {cardSummary ? (
          <pre className="bg-muted border border-border rounded-lg p-3 text-[12px] whitespace-pre-wrap break-words mb-3">
            {cardSummary}
          </pre>
        ) : (
          <p className="text-muted-foreground text-[13px] mb-3">
            No style card yet — add at least one sample below. Extraction runs automatically.
          </p>
        )}
        <details className="text-[12px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Override with your own description
          </summary>
          <div className="mt-2">
            <Textarea
              value={overrideText}
              onChange={(e) => setOverrideText(e.target.value)}
              rows={4}
              placeholder="e.g. Start with 'Hi {first},' — warm but professional. Short paragraphs. End with 'Safe travels,' followed by my name."
              className="text-[12px] mb-2"
            />
            <Button onClick={() => void saveOverride()} disabled={savingOverride} className="h-7 text-[12px] px-3">
              {savingOverride ? "Saving…" : "Save override"}
            </Button>
            {overrideStatus && <span className="ml-2 text-[11px] text-muted-foreground">{overrideStatus}</span>}
          </div>
        </details>
      </section>

      {/* Add sample */}
      <section className="mb-8">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Add a sample
        </h2>
        {data.is_owner && (
          <label className="flex items-center gap-2 text-[12px] mb-2">
            <input
              type="checkbox"
              checked={isHouseStyle}
              onChange={(e) => setIsHouseStyle(e.target.checked)}
            />
            House style (applies to all agents who haven&apos;t added their own samples)
          </label>
        )}
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Optional label (e.g. 'Inquiry response', 'Price update')"
          className="w-full border border-border rounded-md px-3 py-1.5 text-[12px] mb-2"
        />
        <Textarea
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
          rows={6}
          placeholder="Paste an email you sent to a client (min 50 chars)…"
          className="text-[12px] mb-2"
        />
        {saveErr && <p className="text-[11px] text-red-700 dark:text-red-400 mb-1">{saveErr}</p>}
        <Button onClick={() => void addSample()} disabled={saving} className="h-7 text-[12px] px-3">
          {saving ? "Saving…" : "Add sample"}
        </Button>
        <p className="text-[11px] text-muted-foreground mt-1">
          Tip: 3–5 varied samples produce the best results.
        </p>
      </section>

      {/* Sample lists */}
      <SampleList title="Your samples" samples={data.own_samples} onDelete={deleteSample} />
      {data.is_owner && data.house_samples.length > 0 && (
        <SampleList title="House-style samples" samples={data.house_samples} onDelete={deleteSample} />
      )}
    </main>
  );
}

function SampleList({
  title,
  samples,
  onDelete,
}: {
  title: string;
  samples: VoiceSample[];
  onDelete: (id: string) => void;
}): React.JSX.Element | null {
  if (samples.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        {title} ({samples.length})
      </h2>
      <ul className="space-y-2">
        {samples.map((s) => (
          <li key={s.id} className="border border-border rounded-lg p-3 text-[12px]">
            <div className="flex items-center justify-between mb-1">
              <span className="text-muted-foreground">{s.source_label || "(no label)"} · {formatDate(s.created_at)}</span>
              <button
                type="button"
                onClick={() => onDelete(s.id)}
                className="text-[11px] text-red-600 hover:underline"
              >
                Remove
              </button>
            </div>
            <p className="line-clamp-3 text-foreground">{s.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
