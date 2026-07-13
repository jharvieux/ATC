"use client";

// #1888 §6.10 — Platform-admin UI for the four feedback_* retrieval knobs read
// by compute_feedback_factor on the rag side. Global platform settings —
// tenants cannot override. Saves POST a RAG-sync event (these keys are
// sync-eligible), so no manual mirroring is needed.

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

type FeedbackKey =
  | "feedback_adjustment_limit"
  | "feedback_min_signal_count"
  | "feedback_period_days"
  | "feedback_decay_halflife_days";

interface KnobSpec {
  label: string;
  step: string;
  min: number;
  max: number;
  integer: boolean;
  help: string;
}

const KNOBS: Record<FeedbackKey, KnobSpec> = {
  feedback_adjustment_limit: {
    label: "Adjustment limit",
    step: "0.01",
    min: 0,
    max: 0.5,
    integer: false,
    help: "Max magnitude of the signed adjustment feedback can apply to a chunk's retrieval score. 0 disables feedback influence entirely.",
  },
  feedback_min_signal_count: {
    label: "Min signal count",
    step: "1",
    min: 1,
    max: 100,
    integer: true,
    help: "Minimum number of feedback signals (within the lookback window) before any adjustment is applied.",
  },
  feedback_period_days: {
    label: "Period (days)",
    step: "1",
    min: 1,
    max: 365,
    integer: true,
    help: "Lookback window used for the minimum-signal-count check.",
  },
  feedback_decay_halflife_days: {
    label: "Decay half-life (days)",
    step: "1",
    min: 1,
    max: 365,
    integer: true,
    help: "Half-life for the exponential decay that down-weights older feedback signals.",
  },
};

const KEYS = Object.keys(KNOBS) as FeedbackKey[];

export default function AdminFeedbackSettingsPage(): JSX.Element {
  const [values, setValues] = useState<Record<FeedbackKey, number> | null>(null);
  const [draft, setDraft] = useState<Record<FeedbackKey, string>>({
    feedback_adjustment_limit: "",
    feedback_min_signal_count: "",
    feedback_period_days: "",
    feedback_decay_halflife_days: "",
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const res = await adminFetch("/api/admin/feedback-settings");
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const body = (await res.json()) as Record<FeedbackKey, number>;
      setValues(body);
      setDraft(Object.fromEntries(KEYS.map((k) => [k, body[k].toString()])) as Record<FeedbackKey, string>);
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
      const body: Partial<Record<FeedbackKey, number>> = {};
      for (const k of KEYS) {
        const spec = KNOBS[k];
        const n = Number(draft[k]);
        if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.integer && !Number.isInteger(n))) {
          setError(`${spec.label} must be ${spec.integer ? "an integer" : "a number"} in [${spec.min}, ${spec.max}]`);
          setBusy(false);
          return;
        }
        if (!values || values[k] !== n) body[k] = n;
      }
      if (Object.keys(body).length === 0) {
        setMsg("No changes.");
        setBusy(false);
        return;
      }
      const res = await adminFetch("/api/admin/feedback-settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { updated?: FeedbackKey[]; values?: Record<FeedbackKey, number>; error?: string };
      if (!res.ok) throw new Error(parsed.error ?? "save failed");
      setMsg(`Updated: ${(parsed.updated ?? []).join(", ")}. RAG-sync event enqueued.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="px-6 py-6">Loading…</main>;

  return (
    <main className="px-6 py-6 max-w-[720px]">
      <h1>Feedback settings</h1>
      <p className="text-muted-foreground">
        Tunes how customer feedback signals adjust chunk retrieval scores (§6.10). These knobs are read by
        <code className="mx-1">compute_feedback_factor</code>
        on the rag side; saving here enqueues a sync event so the rag replica stays current.
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
          {KEYS.map((k) => (
            <tr key={k}>
              <td className="px-3 py-1.5 border-b border-muted font-semibold">{KNOBS[k].label}</td>
              <td className="px-3 py-1.5 border-b border-muted">
                <input
                  type="number"
                  step={KNOBS[k].step}
                  min={KNOBS[k].min}
                  max={KNOBS[k].max}
                  value={draft[k]}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                  disabled={busy}
                  className="w-24 p-1 border border-border rounded text-sm"
                />
              </td>
              <td className="px-3 py-1.5 border-b border-muted text-muted-foreground">{KNOBS[k].help}</td>
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
      </div>
    </main>
  );
}
