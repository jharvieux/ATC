// mailing_address is a JSONB column ({line1, city, state, zip, country}) in the
// DB but is often typed as string|null in TypeScript. Coerce it to a flat string
// for email footers so renderToStaticMarkup never receives an object as a React
// child (which throws "Objects are not valid as a React child" and 500s the
// send). Accepts unknown so every call site — typed string or not — is safe.
export function formatMailingAddress(addr: unknown): string {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  const a = addr as Record<string, string | undefined>;
  return [a.line1, a.city, a.state && a.zip ? `${a.state} ${a.zip}` : (a.state ?? a.zip), a.country]
    .filter(Boolean)
    .join(", ");
}
