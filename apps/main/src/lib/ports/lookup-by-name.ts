// #484 — resolve a CruiseMapper-style port string to its stored coordinates.
//
// CruiseMapper emits port labels, not IATA codes ("Roatán, Honduras",
// "Mahogany Bay"), so we match on port_name first, then on the name_aliases
// TEXT[] column. Coordinates feed the multi-day weather chart (PR #482).

import type { SupabaseClient } from "@supabase/supabase-js";

export interface PortLookup {
  port_code: string;
  port_name: string;
  latitude: number | null;
  longitude: number | null;
}

const COLS = "port_code, port_name, latitude, longitude";

// Build a single-element Postgres text[] containment literal: {"<value>"}.
// We quote the element and escape backslashes + double-quotes so values
// containing commas ("Roatán, Honduras") survive — supabase-js `.contains`
// joins array values with bare commas and would split such a value into two
// elements (the same comma hazard that broke the #483 `.or()` lookup).
export function pgTextArrayContainsLiteral(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `{"${escaped}"}`;
}

export async function lookupPortByName(
  db: Pick<SupabaseClient, "from">,
  port_name: string,
): Promise<PortLookup | null> {
  const name = port_name.trim();
  if (name.length === 0) return null;

  const exact = await db
    .from("port_info_chunks")
    .select(COLS)
    .eq("port_name", name)
    .maybeSingle();
  if (exact.error) {
    throw new Error(`port_info_chunks.lookup.exact failed: ${exact.error.message}`);
  }
  if (exact.data) return exact.data as PortLookup;

  const alias = await db
    .from("port_info_chunks")
    .select(COLS)
    .filter("name_aliases", "cs", pgTextArrayContainsLiteral(name))
    .limit(1)
    .maybeSingle();
  if (alias.error) {
    throw new Error(`port_info_chunks.lookup.alias failed: ${alias.error.message}`);
  }
  return (alias.data as PortLookup | null) ?? null;
}
