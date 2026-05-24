"use client";

// BP22 §6 — Platform-admin UI for the four retrieval composite-weight knobs
// (match / authority / recency exponents + feedback coefficient).
//
// Defaults are 1.0 across the board, which reproduces the pre-BP22 formula
// exactly. Tenants cannot override — these are platform-wide.

import { useEffect, useState } from "react";

type WeightKey = "match" | "authority" | "recency" | "feedback";

const WEIGHT_KEYS: readonly WeightKey[] = ["match", "authority", "recency", "feedback"];

const HELP: Record<WeightKey, string> = {
  match: "Exponent on match_score (vector similarity). >1 boosts similarity bias; <1 dampens it; 0 makes match irrelevant.",
  authority: "Exponent on authority_score (trusted-source weight). >1 favours hand-curated chunks; 0 makes authority irrelevant.",
  recency: "Exponent on recency_score (90-day exponential decay). >1 strongly prefers fresh chunks; 0 makes recency irrelevant.",
  feedback: "Coefficient on the additive feedback_factor term. 0 disables feedback influence; values >1 amplify it.",
};

export default function AdminRetrievalWeightsPage(): JSX.Element {
  const [values, setValues] = useState<Record<WeightKey, number> | null>(null);
  const [draft, setDraft] = useState<Record<WeightKey, string>>({ match: "", authority: "", recency: "", feedback: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/admin/retrieval-weights", {
        headers: { "x-admin-user-id": "admin" },
      });
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const body = (await res.json()) as Record<WeightKey, number>;
      setValues(body);
      setDraft({
        match: body.match.toString(),
        authority: body.authority.toString(),
        recency: body.recency.toString(),
        feedback: body.feedback.toString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const body: Partial<Record<WeightKey, number>> = {};
      for (const w of WEIGHT_KEYS) {
        const n = Number(draft[w]);
        if (!Number.isFinite(n) || n < 0 || n > 10) {
          setError(`${w} must be a number in [0, 10]`);
          setBusy(false);
          return;
        }
        if (!values || values[w] !== n) body[w] = n;
      }
      if (Object.keys(body).length === 0) {
        setMsg("No changes.");
        setBusy(false);
        return;
      }
      const res = await fetch("/api/admin/retrieval-weights", {
        method: "PUT",
        headers: { "x-admin-user-id": "admin", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { updated?: WeightKey[]; values?: Record<WeightKey, number>; error?: string };
      if (!res.ok) throw new Error(parsed.error ?? "save failed");
      setMsg(`Updated: ${(parsed.updated ?? []).join(", ")} — remember to mirror into the rag DB until the sync job lands.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function resetDefaults(): void {
    setDraft({ match: "1", authority: "1", recency: "1", feedback: "1" });
  }

  if (loading) return <main style={{ padding: 24 }}>Loading…</main>;

  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <h1>Retrieval composite weights</h1>
      <p style={{ color: "#555" }}>
        Tunes how chunks are scored by the rag retrieval RPC. The composite is
        <code style={{ marginLeft: 8, fontFamily: "monospace" }}>
          (match^w<sub>m</sub> × authority^w<sub>a</sub> × recency^w<sub>r</sub>) + w<sub>f</sub> × feedback
        </code>
        . Defaults (1.0 / 1.0 / 1.0 / 1.0) reproduce the pre-BP22 formula.
      </p>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {msg && <p style={{ color: "green" }}>{msg}</p>}

      <table style={{ borderCollapse: "collapse", marginTop: 16 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "6px 12px", borderBottom: "1px solid #ccc" }}>Knob</th>
            <th style={{ textAlign: "left", padding: "6px 12px", borderBottom: "1px solid #ccc" }}>Value</th>
            <th style={{ textAlign: "left", padding: "6px 12px", borderBottom: "1px solid #ccc" }}>What it does</th>
          </tr>
        </thead>
        <tbody>
          {WEIGHT_KEYS.map((w) => (
            <tr key={w}>
              <td style={{ padding: "6px 12px", borderBottom: "1px solid #eee", fontWeight: 600 }}>{w}</td>
              <td style={{ padding: "6px 12px", borderBottom: "1px solid #eee" }}>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="10"
                  value={draft[w]}
                  onChange={(e) => setDraft({ ...draft, [w]: e.target.value })}
                  disabled={busy}
                  style={{ width: 80, padding: 4 }}
                />
              </td>
              <td style={{ padding: "6px 12px", borderBottom: "1px solid #eee", color: "#666" }}>{HELP[w]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
        <button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button onClick={resetDefaults} disabled={busy}>
          Reset to defaults
        </button>
      </div>
    </main>
  );
}
