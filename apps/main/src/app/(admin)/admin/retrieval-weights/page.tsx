"use client";

// BP22 §6 — Platform-admin UI for the four retrieval composite-weight knobs
// (match / authority / recency exponents + feedback coefficient).
//
// Defaults are 1.0 across the board, which reproduces the pre-BP22 formula
// exactly. Tenants cannot override — these are platform-wide.

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

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
      const res = await adminFetch("/api/admin/retrieval-weights");
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
      const res = await adminFetch("/api/admin/retrieval-weights", {
        method: "PUT",
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

  if (loading) return <main className="px-6 py-6">Loading…</main>;

  return (
    <main className="px-6 py-6 max-w-[720px]">
      <h1>Retrieval composite weights</h1>
      <p className="text-muted-foreground">
        Tunes how chunks are scored by the rag retrieval RPC. The composite is
        <code className="ml-2">
          (match^w<sub>m</sub> × authority^w<sub>a</sub> × recency^w<sub>r</sub>) + w<sub>f</sub> × feedback
        </code>
        . Defaults (1.0 / 1.0 / 1.0 / 1.0) reproduce the pre-BP22 formula.
      </p>

      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      {msg && <p className="text-green-700 dark:text-green-400">{msg}</p>}

      <table className="border-collapse mt-4">
        <thead>
          <tr>
            <th className="text-left px-3 py-1.5 border-b border-border">Knob</th>
            <th className="text-left px-3 py-1.5 border-b border-border">Value</th>
            <th className="text-left px-3 py-1.5 border-b border-border">What it does</th>
          </tr>
        </thead>
        <tbody>
          {WEIGHT_KEYS.map((w) => (
            <tr key={w}>
              <td className="px-3 py-1.5 border-b border-muted font-semibold">{w}</td>
              <td className="px-3 py-1.5 border-b border-muted">
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="10"
                  value={draft[w]}
                  onChange={(e) => setDraft({ ...draft, [w]: e.target.value })}
                  disabled={busy}
                  className="w-20 p-1 border border-border rounded text-sm"
                />
              </td>
              <td className="px-3 py-1.5 border-b border-muted text-muted-foreground">{HELP[w]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-6 flex gap-3">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md font-semibold text-sm disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          onClick={resetDefaults}
          disabled={busy}
          className="px-4 py-2 border border-border rounded-md text-sm disabled:opacity-50"
        >
          Reset to defaults
        </button>
      </div>
    </main>
  );
}
