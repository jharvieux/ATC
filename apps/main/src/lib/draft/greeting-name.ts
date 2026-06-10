// #904 / D-194 — derive the customer's greeting name from a parsed email
// sender. The contract that matters (D-193 decision 5): NEVER silently guess.
// A null return means the UI shows an editable empty field and the draft
// instruction keeps a literal [name] placeholder.

// Mailbox local-parts that are role accounts, not people. A greeting of
// "Hi Noreply," in the TA's voice is worse than the placeholder.
const ROLE_LOCALPARTS = new Set([
  "info", "contact", "hello", "support", "sales", "admin", "office",
  "noreply", "no-reply", "donotreply", "do-not-reply", "bookings",
  "reservations", "inquiries", "enquiries", "mail", "team", "help",
]);

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * @param displayName the From header's display name (may be empty)
 * @param email       the From address (may be empty)
 * @returns first name for the greeting, or null → [name] placeholder
 */
export function deriveGreetingName(
  displayName: string | null | undefined,
  email: string | null | undefined,
): string | null {
  const dn = (displayName ?? "").trim().replace(/^["']+|["']+$/g, "");
  if (dn) {
    // "Sarah Mitchell" → Sarah; "Mitchell, Sarah" → Sarah (comma = surname-first).
    const commaParts = dn.split(",").map((s) => s.trim()).filter(Boolean);
    const candidate = commaParts.length === 2
      ? commaParts[1]!.split(/\s+/)[0]!
      : dn.split(/\s+/)[0]!;
    // Reject non-name shapes (addresses-as-display-name, digits, single chars).
    if (/^[A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,}$/.test(candidate) && !candidate.includes("@")) {
      return titleCase(candidate);
    }
  }

  const local = (email ?? "").split("@")[0]?.trim().toLowerCase() ?? "";
  if (!local || ROLE_LOCALPARTS.has(local)) return null;
  // sarah.mitchell / sarah_mitchell / sarah-mitchell → Sarah.
  // Reject local-parts with digits — j.doe99/throwaway shapes aren't names.
  const first = local.split(/[._-]/)[0] ?? "";
  if (/^[a-zà-öø-ÿ]{2,}$/.test(first) && !ROLE_LOCALPARTS.has(first)) {
    return titleCase(first);
  }
  return null;
}
