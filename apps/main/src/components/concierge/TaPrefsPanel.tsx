"use client";

// #1781/#1791 — extracted from ConciergeExperience.tsx (was a 925-line file
// with 4 sub-components defined inline). Renders the "Prefs" sidebar tab:
// reply-tone selector + quality-review pill toggle.

import { useEffect, useState } from "react";
import { TONE_LABELS } from "@/lib/tone/constants";

export function TaPrefsPanel({
  showQualityPill,
  onToggleQualityPill,
}: {
  showQualityPill: boolean;
  onToggleQualityPill: (v: boolean) => void;
}): React.JSX.Element {
  const [tone, setTone] = useState<number>(3);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/memory");
        if (!r.ok) return;
        const data = (await r.json()) as { rapport_tone_level?: number | null } | null;
        setTone(data?.rapport_tone_level ?? 3);
      } catch {
        // network failure — leave the default tone in place
      }
    })();
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      const r = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rapport_tone_level: tone }),
      });
      setStatus(r.ok ? "Saved." : "Couldn't save.");
    } catch {
      setStatus("Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 0",
    borderBottom: "1px solid var(--ta-border)",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: "var(--ta-text-soft)",
  };
  return (
    <div>
      <div style={rowStyle}>
        <span style={labelStyle}>Default agent</span>
        <span style={{ fontSize: 11, color: "var(--ta-text-mute)" }}>Set via agent picker</span>
      </div>
      <div style={{ padding: "8px 0", borderBottom: "1px solid var(--ta-border)" }}>
        <span style={labelStyle}>Reply tone</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {TONE_LABELS.map((label, i) => {
            const level = i + 1;
            return (
              <button
                key={label}
                type="button"
                onClick={() => setTone(level)}
                style={{
                  padding: "3px 10px",
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: `1px solid ${tone === level ? "var(--ta-accent)" : "var(--ta-border-2)"}`,
                  background: tone === level ? "var(--ta-accent-soft)" : "transparent",
                  color: tone === level ? "var(--ta-accent)" : "var(--ta-text-soft)",
                  transition: "all 0.12s",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {tone === 5 && (
          <p style={{ fontSize: 11, color: "var(--ta-amber, #f59e0b)", margin: "6px 0 0" }}>
            ⚠ Profanity is permitted at this tone level.
          </p>
        )}
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Quality-review notice</span>
        <button
          type="button"
          role="switch"
          aria-checked={showQualityPill}
          onClick={() => onToggleQualityPill(!showQualityPill)}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            border: "none",
            background: showQualityPill ? "var(--ta-accent)" : "var(--ta-border-2)",
            cursor: "pointer",
            position: "relative",
            transition: "background 0.2s",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: showQualityPill ? 18 : 2,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.2s",
            }}
          />
        </button>
      </div>
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        style={{
          marginTop: 14,
          padding: "6px 16px",
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 500,
          cursor: saving ? "not-allowed" : "pointer",
          border: "none",
          background: saving ? "var(--ta-surface-2)" : "var(--ta-accent)",
          color: saving ? "var(--ta-text-mute)" : "var(--ta-accent-ink)",
          transition: "background 0.15s",
        }}
      >
        {saving ? "Saving…" : "Save preferences"}
      </button>
      {status && (
        <p
          style={{
            fontSize: 11,
            marginTop: 6,
            color: status === "Saved." ? "var(--ta-green)" : "#F87171",
          }}
        >
          {status}
        </p>
      )}
    </div>
  );
}
