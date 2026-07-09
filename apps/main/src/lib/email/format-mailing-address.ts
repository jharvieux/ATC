// mailing_address is a JSONB column ({line1, city, state, zip, country}) in the
// DB but is often typed as string|null in TypeScript. Coerce it to a flat string
// for email footers so renderToStaticMarkup never receives an object as a React
// child (which throws "Objects are not valid as a React child" and 500s the
// send). Accepts unknown so every call site — typed string or not — is safe.
//
// Also accepts `line2` and `postal_code` (an alias for `zip`) — widened for
// #1556 to absorb compliance-nightly.ts's local formatAddress, which used the
// postal_code/line2 field names.
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function formatMailingAddress(addr: unknown): string {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  const a = addr as Record<string, unknown>;
  const line1 = str(a.line1);
  const line2 = str(a.line2);
  const city = str(a.city);
  const state = str(a.state);
  const postal = str(a.zip) ?? str(a.postal_code);
  const country = str(a.country);
  const stateAndPostal = state && postal ? `${state} ${postal}` : (state ?? postal);
  return [line1, line2, city, stateAndPostal, country].filter(Boolean).join(", ");
}
