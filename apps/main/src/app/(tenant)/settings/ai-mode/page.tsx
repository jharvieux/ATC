"use client";

// §9.10.2 — Tenant AI Mode configuration page
// Shows three mode cards (autonomous / draft_only / disabled) and
// the Background AI toggle. Turning off Background AI requires confirmation.

import React, { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import type { AIMode, AIBehaviorFlags } from "@/lib/personas/resolve-ai-behavior";

// ── Mode card definitions ─────────────────────────────────────────────────────

type ModeCard = {
  mode: AIMode;
  title: string;
  description: string;
  features: string[];
  // Relative-cost descriptor (per message). See the current-period spend
  // block at the top of the page for the actual dollar figure.
  costHint: string;
};

const MODE_CARDS: ModeCard[] = [
  {
    mode: "autonomous",
    title: "Autonomous",
    description:
      "AI responds directly to customers without requiring your review. Best for high-volume operations where you trust AI quality.",
    features: [
      "AI responds to customers automatically",
      "Memory extraction active",
      "RAG knowledge search: full AI normalization",
      "Pre-cruise emails: AI personalized",
      "Forum moderation: Haiku-screened",
    ],
    costHint: "Highest per-message",
  },
  {
    mode: "draft_only",
    title: "Draft Only",
    description:
      "AI writes draft responses for your team to review and send. Customer chat never sends without human approval.",
    features: [
      "AI drafts responses; human sends",
      "Memory extraction active",
      "RAG knowledge search: full AI normalization",
      "Pre-cruise emails: AI personalized",
      "Forum moderation: Haiku-screened",
    ],
    costHint: "Slightly less than Autonomous",
  },
  {
    mode: "disabled",
    title: "Disabled",
    description:
      "AI does not respond to or draft customer messages. Background AI features remain active.",
    features: [
      "Customer chat AI: fully off",
      "Memory extraction: still active",
      "RAG knowledge search: still active",
      "Pre-cruise emails: still AI personalized",
      "Forum moderation: still active",
    ],
    costHint: "Background-AI only (lowest)",
  },
];

// ── What disabled does NOT cover ──────────────────────────────────────────────

const DISABLED_COVERAGE_TABLE: { feature: string; affected: boolean }[] = [
  { feature: "Customer chat — autonomous response", affected: true },
  { feature: "Customer chat — draft for review", affected: true },
  { feature: "Memory extraction", affected: false },
  { feature: "Persona addendum screening", affected: false },
  { feature: "RAG normalization AI", affected: false },
  { feature: "Pre-cruise email personalization", affected: false },
  { feature: "Forum moderation", affected: false },
  { feature: "Abuse signal screening", affected: false },
];

// ── Component ─────────────────────────────────────────────────────────────────

type PageState = {
  ai_mode: AIMode;
  background_ai_enabled: boolean;
  flags: AIBehaviorFlags | null;
  saving: boolean;
  error: string | null;
};

interface CostProjection {
  period_start: string;
  period_end: string;
  days_elapsed: number;
  total_days_in_month: number;
  current_period_spend: string;
  projected_month_end_spend: string;
  currency: string;
}

export default function AIModePage() {
  const [state, setState] = useState<PageState>({
    ai_mode: "autonomous",
    background_ai_enabled: true,
    flags: null,
    saving: false,
    error: null,
  });

  const [disabledExpanded, setDisabledExpanded] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [costProjection, setCostProjection] = useState<CostProjection | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tenant/ai-config/cost-projection");
        if (!res.ok) return;
        const data = (await res.json()) as CostProjection;
        if (!cancelled) setCostProjection(data);
      } catch {
        // Cost display is best-effort; failure shows the fallback string.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveMode(ai_mode: AIMode) {
    setState((s) => ({ ...s, saving: true, error: null }));
    try {
      const res = await fetch("/api/tenant/ai-config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ai_mode }),
      });
      const data = await res.json() as Partial<PageState>;
      if (!res.ok) {
        setState((s) => ({ ...s, saving: false, error: (data as { error?: string }).error ?? "Save failed" }));
        return;
      }
      setState((s) => ({
        ...s,
        ai_mode: data.ai_mode ?? s.ai_mode,
        background_ai_enabled: data.background_ai_enabled ?? s.background_ai_enabled,
        flags: data.flags ?? s.flags,
        saving: false,
      }));
    } catch {
      setState((s) => ({ ...s, saving: false, error: "Network error" }));
    }
  }

  async function saveBackgroundAI(background_ai_enabled: boolean) {
    setState((s) => ({ ...s, saving: true, error: null }));
    try {
      const res = await fetch("/api/tenant/ai-config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ background_ai_enabled }),
      });
      const data = await res.json() as Partial<PageState>;
      if (!res.ok) {
        setState((s) => ({ ...s, saving: false, error: (data as { error?: string }).error ?? "Save failed" }));
        return;
      }
      setState((s) => ({
        ...s,
        background_ai_enabled: data.background_ai_enabled ?? s.background_ai_enabled,
        flags: data.flags ?? s.flags,
        saving: false,
      }));
    } catch {
      setState((s) => ({ ...s, saving: false, error: "Network error" }));
    }
  }

  function handleBackgroundAIToggle(checked: boolean) {
    if (!checked) {
      // Turning OFF requires confirmation
      setConfirmDialogOpen(true);
    } else {
      void saveBackgroundAI(true);
    }
  }

  function handleConfirmDisableBackgroundAI() {
    setConfirmDialogOpen(false);
    void saveBackgroundAI(false);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-2">AI Mode Configuration</h1>
      <p className="text-gray-500 mb-4">
        Control how AI responds to your customers and which background AI features are active.
      </p>

      {/* §27.12 — current-period AI spend display.
          Single shared block above the cards (no per-mode multipliers
          — historical data isn't deep enough to make those honest yet). */}
      {costProjection && (
        <Card className="mb-8 bg-blue-50 border-blue-200">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-xs text-gray-600 uppercase tracking-wide">This billing period</p>
                <p className="text-xl font-semibold text-gray-900">
                  {costProjection.currency} {costProjection.current_period_spend}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Day {costProjection.days_elapsed} of {costProjection.total_days_in_month}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-600 uppercase tracking-wide">Projected month-end</p>
                <p className="text-xl font-semibold text-gray-900">
                  {costProjection.currency} {costProjection.projected_month_end_spend}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Linear extrapolation from current pace
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {state.error && (
        <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {state.error}
        </div>
      )}

      {/* Mode cards */}
      <section className="mb-10">
        <h2 className="text-lg font-medium mb-4">Customer Chat Mode</h2>
        <div className="grid gap-4">
          {MODE_CARDS.map((card) => {
            const isSelected = state.ai_mode === card.mode;
            return (
              <Card
                key={card.mode}
                className={`cursor-pointer transition-colors ${isSelected ? "border-blue-500 bg-blue-50" : "hover:border-gray-400"}`}
                onClick={() => !state.saving && void saveMode(card.mode)}
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      {card.title}
                      {isSelected && (
                        <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded-full">
                          Active
                        </span>
                      )}
                    </CardTitle>
                    <span className="text-xs text-gray-500">{card.costHint}</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-600 mb-3">{card.description}</p>
                  <ul className="text-sm space-y-1">
                    {card.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-gray-700">
                        <span className="text-green-500 mt-0.5">✓</span>
                        {f}
                      </li>
                    ))}
                  </ul>

                  {card.mode === "disabled" && (
                    <div className="mt-4">
                      <button
                        type="button"
                        className="text-sm text-blue-600 underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDisabledExpanded((v) => !v);
                        }}
                      >
                        {disabledExpanded ? "Hide" : "What does Disabled NOT cover?"} ▾
                      </button>
                      {disabledExpanded && (
                        <div className="mt-3 overflow-hidden rounded border">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="text-left px-3 py-2 font-medium text-gray-600">
                                  Feature
                                </th>
                                <th className="text-center px-3 py-2 font-medium text-gray-600">
                                  Affected by Disabled mode?
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {DISABLED_COVERAGE_TABLE.map((row) => (
                                <tr key={row.feature} className="border-t">
                                  <td className="px-3 py-2 text-gray-700">{row.feature}</td>
                                  <td className="px-3 py-2 text-center">
                                    {row.affected ? (
                                      <span className="text-red-600">Yes — off</span>
                                    ) : (
                                      <span className="text-green-600">No — still on</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Background AI toggle */}
      <section>
        <h2 className="text-lg font-medium mb-4">Background AI</h2>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Background AI Features</p>
                <p className="text-sm text-gray-500 mt-1">
                  Memory extraction, RAG normalization, email personalization, forum moderation, and
                  persona addendum screening. Turning this off reduces platform functionality.
                </p>
              </div>
              <Switch
                checked={state.background_ai_enabled}
                onCheckedChange={handleBackgroundAIToggle}
                disabled={state.saving}
                aria-label="Background AI enabled"
              />
            </div>

            {!state.background_ai_enabled && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded text-amber-800 text-sm">
                <strong>Background AI is OFF.</strong> Some platform features have reduced
                functionality: memory extraction is paused, persona addendums cannot be saved, RAG
                normalization is disabled, pre-cruise emails use templates only, and forum
                moderation requires manual coordinator review.
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Confirmation dialog for turning off Background AI */}
      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogTrigger asChild>
          <span className="hidden" />
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off Background AI?</DialogTitle>
            <DialogDescription>
              Background AI is OFF. Some platform features have reduced functionality:
              memory extraction is paused, persona addendums cannot be saved, RAG normalization is
              disabled, pre-cruise emails will use templates only, and forum moderation will require
              manual coordinator review.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="default"
              onClick={handleConfirmDisableBackgroundAI}
            >
              Turn off Background AI
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
