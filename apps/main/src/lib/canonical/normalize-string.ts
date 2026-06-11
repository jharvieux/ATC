// §781 Phase 2 — canonical string normalizer.
// Shared between resolveCanonical() and the backfill job.

const TRAILING_SUFFIXES = [
  "ocean cruises",
  "cruise lines",
  "cruise line",
  "cruises",
  "cruise",
  "lines",
  "line",
  "ocean",
];

const LEADING_PREFIXES = ["the"];

export function normalizeForMatch(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function safeVariants(norm: string): string[] {
  const result = new Set<string>([norm]);

  let base = norm;
  for (const prefix of LEADING_PREFIXES) {
    if (base.startsWith(prefix + " ")) {
      base = base.slice(prefix.length + 1);
      result.add(base);
      break;
    }
  }

  // Try stripping trailing suffixes (longest first to avoid partial matches).
  for (const v of [...result]) {
    for (const suffix of TRAILING_SUFFIXES) {
      if (v.endsWith(" " + suffix)) {
        const stripped = v.slice(0, v.length - suffix.length - 1).trim();
        if (stripped.length > 1) result.add(stripped);
      }
    }
  }

  return [...result];
}
