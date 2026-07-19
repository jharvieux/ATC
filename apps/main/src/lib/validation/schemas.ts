// #2010 — shared request-body validation primitives.
//
// These consolidate hand-rolled regexes that had already been copy-pasted into
// multiple route handlers (two email regexes, two UUID regexes, a duplicated
// visibility Set) where they were free to drift apart. They are intentionally
// thin wrappers over zod (already the codebase's validation library, e.g. the
// Inngest event registry) so a single definition is the source of truth.

import { z } from "zod";

// Loose email shape. Kept as this explicit regex rather than z.string().email()
// so the accepted-address set is byte-for-byte what the group-invite and
// email-preview routes already enforced — this dedupes the two copies, it does
// not re-tighten validation (a behavior change on those endpoints is out of
// scope here).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailSchema = z.string().max(254).regex(EMAIL_RE);

/** True for a syntactically-valid, ≤254-char email (loose RFC-ish shape). */
export function isValidEmail(value: string): boolean {
  return emailSchema.safeParse(value).success;
}

export const uuidSchema = z.string().uuid();

/** True for a canonical 8-4-4-4-12 hex UUID (case-insensitive). */
export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

// §18.6 — an invitee's roster-visibility preference.
export const GROUP_VISIBILITY_CHOICES = ["no_opinion", "be_anonymous", "show_me_anyway"] as const;
export const groupVisibilityChoiceSchema = z.enum(GROUP_VISIBILITY_CHOICES);
export type GroupVisibilityChoice = z.infer<typeof groupVisibilityChoiceSchema>;

/** True for a recognized group-visibility choice. */
export function isGroupVisibilityChoice(value: string): value is GroupVisibilityChoice {
  return groupVisibilityChoiceSchema.safeParse(value).success;
}
