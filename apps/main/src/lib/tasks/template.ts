// BP37 §37.4.4 — Simple template substitution for task title/description.
//
// Intentionally string-replace, NOT a Handlebars/Jinja runtime — keeps
// the substitution surface controlled and avoids template-injection risk.
// Variables come from typed record fields, never from free-text or AI output.

export type SubstitutionContext = {
  contact?: { first_name?: string | null; last_name?: string | null } | null;
  quote?: { cruise_line?: string | null; sailing_date?: string | null } | null;
  booking?: { cruise_line?: string | null; sailing_date?: string | null } | null;
  days_until_sailing?: number | null;
};

export function applyTemplate(template: string, ctx: SubstitutionContext): string {
  return template
    .replace(/\{\{contact\.first_name\}\}/g, ctx.contact?.first_name ?? "")
    .replace(/\{\{contact\.last_name\}\}/g, ctx.contact?.last_name ?? "")
    .replace(/\{\{quote\.cruise_line\}\}/g, ctx.quote?.cruise_line ?? "")
    .replace(/\{\{quote\.sailing_date\}\}/g, ctx.quote?.sailing_date ?? "")
    .replace(/\{\{booking\.cruise_line\}\}/g, ctx.booking?.cruise_line ?? "")
    .replace(/\{\{booking\.sailing_date\}\}/g, ctx.booking?.sailing_date ?? "")
    .replace(/\{\{days_until_sailing\}\}/g, ctx.days_until_sailing != null ? String(ctx.days_until_sailing) : "");
}
