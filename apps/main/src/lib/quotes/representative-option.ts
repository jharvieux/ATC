// §38.4.3 — Pick the single option a quote should display/render/quote as.
//
// A §38 quote is a container; trip detail and per-option financials live on
// quote_options. When the customer has selected an option (customer_selected
// = TRUE, enforced unique-per-quote by a partial index) that is the
// representative option. Otherwise the lowest option_index wins — the first
// option the agent built. Returns null only for a container with zero options
// (a fresh draft). Callers pass rows in whatever order the query returned, so
// this does not assume the input is pre-sorted.

export interface RepresentativeOptionFields {
  option_index: number;
  customer_selected: boolean | null;
}

export function selectRepresentativeOption<T extends RepresentativeOptionFields>(
  options: readonly T[],
): T | null {
  if (options.length === 0) return null;
  const selected = options.find((o) => o.customer_selected === true);
  if (selected) return selected;
  return options.reduce((lowest, o) =>
    o.option_index < lowest.option_index ? o : lowest,
  );
}
