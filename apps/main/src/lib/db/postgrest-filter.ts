// Escaping for user-supplied values interpolated into a PostgREST `.or()` filter
// string (e.g. `first_name.ilike.<value>`). supabase-js URL-encodes the filter
// for transport, but PostgREST re-parses the decoded string, so the escaping
// must happen here — before the value reaches the filter — not at the HTTP layer.
//
// Two distinct threats:
//   1. Filter-injection — `,` separates OR conditions, `(` `)` group them, and
//      `:` introduces operator modifiers. An unescaped one lets a caller inject
//      extra filter terms into the OR group, so they are removed.
//   2. LIKE-wildcard widening — `%` and `_` are SQL wildcards and `\` is the
//      LIKE escape char; they are backslash-escaped so the term matches the
//      literal text the user typed.
//
// `.` and `@` are deliberately preserved: in a `column.operator.value` triple
// PostgREST splits only on the first two dots, so a `.` in the value is data,
// not syntax — and contact email search needs both characters.
export function escapeIlikeOrTerm(raw: string): string {
  const literal = raw
    .trim()
    .replace(/[\\%_]/g, (c) => `\\${c}`)
    .replace(/[(),:]/g, "");
  return `%${literal}%`;
}
