"use client";

// Design spec: "Avatar stack / '+N'... clicking opens the full guest list
// (modal or separate route) — out of scope to design in detail, but must
// exist." The roster is already in the page's data payload, so a modal is
// the cheapest compliant option — no new route, no new fetch.

import * as React from "react";
import { avatarColorVar, avatarInitials } from "./display";
import type { RosterEntry } from "./types";

const STATUS_LABEL: Record<RosterEntry["status"], string> = {
  booked: "Booked",
  interested: "Interested",
  pending: "Pending",
  not_going: "Can't make it",
};

export function GuestListModal({ roster, onClose }: { roster: RosterEntry[]; onClose: () => void }) {
  React.useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-[var(--cruise-surface)] p-6 shadow-[var(--cruise-card-shadow)]"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close guest list"
          className="absolute right-4 top-4 text-[var(--cruise-text-muted)]"
        >
          ✕
        </button>
        <h3 className="mb-4 font-[family-name:var(--font-quicksand)] text-lg font-bold text-[var(--cruise-text)]">
          Guest list
        </h3>
        <div className="flex flex-col gap-3 overflow-y-auto">
          {roster.map((entry) => (
            <div key={entry.id} className="flex items-center gap-3">
              <div
                className="flex h-8 w-8 flex-none items-center justify-center rounded-[var(--cruise-radius-pill)] font-[family-name:var(--font-quicksand)] text-xs font-bold text-white"
                style={{ background: avatarColorVar(entry.avatarColor) }}
              >
                {avatarInitials(entry)}
              </div>
              <div className="text-sm font-semibold text-[var(--cruise-text)]">{entry.displayName}</div>
              <div className="ml-auto text-xs font-medium text-[var(--cruise-text-muted)]">{STATUS_LABEL[entry.status]}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
