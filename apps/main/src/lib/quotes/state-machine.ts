// §12.4 — Quote state-machine.
//
// Allowed transitions per §12.4:
//   draft    → sent
//   sent     → viewed, accepted, declined, expired
//   viewed   → accepted, declined, expired
//   accepted → converted
//   declined, expired, converted are terminal

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "declined"
  | "expired"
  | "converted";

export class InvalidQuoteTransitionError extends Error {
  constructor(
    public readonly from: QuoteStatus,
    public readonly to: QuoteStatus,
  ) {
    super(`Invalid quote state transition: ${from} → ${to}`);
    this.name = "InvalidQuoteTransitionError";
  }
}

export const VALID_STATUSES = new Set<QuoteStatus>(["draft", "sent", "viewed", "accepted", "declined", "expired", "converted"]);

const ALLOWED_TRANSITIONS: Record<QuoteStatus, ReadonlySet<QuoteStatus>> = {
  draft:     new Set<QuoteStatus>(["sent"]),
  sent:      new Set<QuoteStatus>(["viewed", "accepted", "declined", "expired"]),
  viewed:    new Set<QuoteStatus>(["accepted", "declined", "expired"]),
  accepted:  new Set<QuoteStatus>(["converted"]),
  declined:  new Set<QuoteStatus>([]),
  expired:   new Set<QuoteStatus>([]),
  converted: new Set<QuoteStatus>([]),
};

export function assertValidQuoteTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (!VALID_STATUSES.has(from) || !VALID_STATUSES.has(to)) {
    throw new InvalidQuoteTransitionError(from, to);
  }
  if (!ALLOWED_TRANSITIONS[from].has(to)) {
    throw new InvalidQuoteTransitionError(from, to);
  }
}
