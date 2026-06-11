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
  if (base.startsWith("the ")) {
    base = base.slice(4);
    result.add(base);
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
