// BP34 §34.2.4 — Persistent CRM banner for Gmail health.
//
// Hits /api/integrations/gmail/health on mount and renders a banner
// when status is anything other than 'connected'. The component is
// intentionally minimal — drop into the CRM layout above the nav.
//
// Tier-gated paths (BYO Research with no Gmail integration at all)
// should not mount this component; the layout decides whether to
// include it based on the tenant's tier.

"use client";

import { useEffect, useState } from "react";

type HealthState = {
  health_status: "connected" | "token_expired" | "revoked" | "disconnected";
  connected_email: string | null;
  last_health_error: string | null;
};

const COPY: Record<HealthState["health_status"], { title: string; detail: string }> = {
  connected: { title: "", detail: "" },
  token_expired: {
    title: "Gmail token expired",
    detail: "Reconnect your Gmail account to resume IMPORT email processing.",
  },
  revoked: {
    title: "Gmail access revoked",
    detail: "Reconnect your Gmail account to resume IMPORT email processing.",
  },
  disconnected: {
    title: "Gmail not connected",
    detail: "Connect your Gmail account to enable email-based imports.",
  },
};

export function GmailHealthBanner(): JSX.Element | null {
  const [state, setState] = useState<HealthState | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/integrations/gmail/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setState(d as HealthState);
      })
      .catch(() => {
        /* swallow — best-effort surface */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state || state.health_status === "connected") return null;

  const copy = COPY[state.health_status];
  return (
    <div
      role="alert"
      className="bg-orange-50 dark:bg-orange-950/20 border-b border-orange-300 dark:border-orange-700 text-orange-900 dark:text-orange-200 py-2.5 px-4 flex gap-3 items-center text-[14px]"
    >
      <strong>{copy.title}</strong>
      <span>{copy.detail}</span>
      <a
        href="/settings/integrations/gmail"
        className="ml-auto text-orange-900 dark:text-orange-200 font-semibold hover:underline"
      >
        Manage →
      </a>
    </div>
  );
}
