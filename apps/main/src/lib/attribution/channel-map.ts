// BP35 §35.5 — utm_medium → channel normalization map (v1).
//
// Map version is a config constant for v1; storing per-touch map_version
// alongside the channel value is deferred (§35.10 — out of scope until
// the default map churns).

const MAP: Array<[RegExp, string]> = [
  // ordering matters: most-specific first; later patterns won't reach
  // values that already matched.
  [/^(social|sm|social_media)$/i, "social"],
  [/^(cpc|ppc|paid_search|search)$/i, "search"],
  [/^(email|e-mail|newsletter)$/i, "email"],
  [/^(referral|partner|affiliate)$/i, "referral"],
];

export function channelFromUtmMedium(utm_medium: string | null | undefined): string {
  if (!utm_medium || utm_medium.trim().length === 0) return "direct";
  const v = utm_medium.trim();
  for (const [re, label] of MAP) {
    if (re.test(v)) return label;
  }
  return "other";
}

// §35.5 — manual/imported touches default to 'offline'. manual_category
// is stored verbatim; mapping arbitrary categories to specific channels
// is deferred (out of scope for v1).
export function channelFromManualCategory(_category: string | null | undefined): string {
  return "offline";
}
