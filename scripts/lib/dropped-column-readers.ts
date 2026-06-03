// Pure logic for the dropped-column-reader CI gate.
//
// Postgres column names are referenced from application code only as
// STRINGS (`.from("quotes").select("cruise_line, ...")`), so `tsc` cannot
// see that a migration dropped a column the code still asks Postgres for.
// That is exactly how BP38/#137 shipped: the §38 contract migration dropped
// the per-option trip/financial columns off `quotes` while ~9 readers still
// SELECTed them, and nothing failed until those readers 500'd in prod.
//
// This module answers, mechanically: "does any reader still reference a
// column on the table it was dropped from?" It is deliberately TABLE-AWARE.
// A column name alone is not enough: `cruise_line` and `sailing_date` were
// dropped from `quotes` but remain live on `bookings`, so a name-only grep
// would both miss the real bug (it'd see them as still-live) and flag the
// legitimate bookings reader. So we tie each dropped column to the table it
// was dropped from, and only flag code that reads that column FROM that
// table via the `.from("<table>")` query chain.
//
// Known limits (documented, not hidden): a `.select("*")` followed by a
// later `row.col` property access is not caught (no column string near the
// `.from`), and a reference more than ~one query-chain away from its
// `.from(...)` is not caught. The load-bearing case — a column named
// explicitly in the query chain that builds the failing DB request — is.
// I/O (reading files) lives in the orchestrator script so this stays pure.

export interface Migration {
  file: string;
  content: string;
}

export interface SourceFile {
  file: string;
  content: string;
}

export interface Violation {
  file: string;
  line: number;
  table: string;
  column: string;
  snippet: string;
}

type ColumnOp = { table: string; kind: "add" | "drop"; column: string };

// Strip SQL comments + collapse whitespace so a single regex survives
// formatting differences across migrations (same approach as lint-migrations).
function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Parse every `ALTER TABLE <t> ADD/DROP/RENAME COLUMN` op, in migration
// (filename-sorted) order. A `RENAME COLUMN a TO b` is a drop of `a` plus an
// add of `b`. CREATE TABLE column lists are intentionally NOT parsed: a
// column that was only ever created and then dropped still produces a single
// `drop` op, which is all the fold below needs.
export function parseColumnOps(migrations: Migration[]): ColumnOp[] {
  const ops: ColumnOp[] = [];
  for (const m of migrations) {
    const norm = normalize(m.content);
    for (const stmt of norm.split(";")) {
      const alter =
        /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/i.exec(
          stmt,
        );
      if (!alter) continue;
      const table = alter[1].toLowerCase();

      const dropRe = /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
      let d: RegExpExecArray | null;
      while ((d = dropRe.exec(stmt)) !== null) {
        ops.push({ table, kind: "drop", column: d[1].toLowerCase() });
      }

      const addRe = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
      let a: RegExpExecArray | null;
      while ((a = addRe.exec(stmt)) !== null) {
        ops.push({ table, kind: "add", column: a[1].toLowerCase() });
      }

      const renameRe =
        /\bRENAME\s+COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*)/gi;
      let r: RegExpExecArray | null;
      while ((r = renameRe.exec(stmt)) !== null) {
        ops.push({ table, kind: "drop", column: r[1].toLowerCase() });
        ops.push({ table, kind: "add", column: r[2].toLowerCase() });
      }
    }
  }
  return ops;
}

// Fold ops into the set of columns that are REMOVED at migration HEAD, keyed
// by table. Last op wins, so a drop-then-re-add (expand/contract on the same
// table) correctly leaves the column live and out of the removed set.
export function computeRemovedColumns(ops: ColumnOp[]): Map<string, Set<string>> {
  const lastKind = new Map<string, "add" | "drop">();
  for (const op of ops) lastKind.set(`${op.table}.${op.column}`, op.kind);

  const removed = new Map<string, Set<string>>();
  for (const [key, kind] of lastKind) {
    if (kind !== "drop") continue;
    const dot = key.indexOf(".");
    const table = key.slice(0, dot);
    const column = key.slice(dot + 1);
    if (!removed.has(table)) removed.set(table, new Set());
    removed.get(table)!.add(column);
  }
  return removed;
}

const FROM_RE = /\.from\(\s*["'](?:public\.)?([a-z_][a-z0-9_]*)["']\s*\)/gi;
// A query chain rarely spans more than a few hundred chars; cap the window so
// a dropped column far below an unrelated `.from(...)` is not misattributed.
const WINDOW_CHARS = 800;
// Supabase column references reach Postgres only as STRINGS: `.select("a, b")`,
// `.eq("col", v)`, `.order("col")`. A bare `row.col` is a TypeScript property
// access that tsc already checks against the row type — not the blind spot this
// gate guards — so we only match column names inside string literals. That stops
// a property access on a same-named LIVE column of a DIFFERENT object (e.g.
// `booking.cruise_line` sitting within 800 chars of a `.from("quotes")`) from
// being misattributed to the dropped `quotes.cruise_line`.
const STRING_LITERAL_RE = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;

// Flag source where a column is referenced (whole-word) inside a string literal
// within the query chain rooted at the `.from("<table>")` it was dropped from.
// The window for each `.from(...)` ends at the next `.from(...)` (or
// +WINDOW_CHARS), so one table's chain cannot bleed dropped columns onto the
// next table's read.
export function findViolations(
  removed: Map<string, Set<string>>,
  sources: SourceFile[],
): Violation[] {
  const violations: Violation[] = [];
  if (removed.size === 0) return violations;

  for (const src of sources) {
    const content = src.content;
    const froms: Array<{ table: string; index: number }> = [];
    FROM_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FROM_RE.exec(content)) !== null) {
      froms.push({ table: fm[1].toLowerCase(), index: fm.index });
    }

    for (let i = 0; i < froms.length; i++) {
      const { table, index } = froms[i];
      const removedCols = removed.get(table);
      if (!removedCols || removedCols.size === 0) continue;

      const hardCap = index + WINDOW_CHARS;
      const nextFrom = i + 1 < froms.length ? froms[i + 1].index : content.length;
      const windowEnd = Math.min(nextFrom, hardCap, content.length);
      const windowText = content.slice(index, windowEnd);

      // Spans of string-literal CONTENT within the window (offsets relative to
      // windowText, excluding the surrounding quotes).
      const stringSpans: Array<{ start: number; end: number }> = [];
      STRING_LITERAL_RE.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = STRING_LITERAL_RE.exec(windowText)) !== null) {
        stringSpans.push({ start: sm.index + 1, end: sm.index + sm[0].length - 1 });
      }

      for (const col of removedCols) {
        const colRe = new RegExp(`\\b${escapeRegExp(col)}\\b`, "g");
        let hitIdx: number | null = null;
        for (const span of stringSpans) {
          colRe.lastIndex = 0;
          const cm = colRe.exec(windowText.slice(span.start, span.end));
          if (cm) {
            hitIdx = span.start + cm.index;
            break;
          }
        }
        if (hitIdx === null) continue;
        const absoluteIdx = index + hitIdx;
        const line = content.slice(0, absoluteIdx).split("\n").length;
        const lineStart = content.lastIndexOf("\n", absoluteIdx) + 1;
        let lineEnd = content.indexOf("\n", absoluteIdx);
        if (lineEnd < 0) lineEnd = content.length;
        violations.push({
          file: src.file,
          line,
          table,
          column: col,
          snippet: content.slice(lineStart, lineEnd).trim(),
        });
      }
    }
  }
  return violations;
}

// Exceptions file format mirrors db/rls-exceptions.txt: `table.column # reason`.
// An entry requires a reason (text after `#`) to be honored, so a bare
// silencing line can't slip through review.
export function parseExceptions(text: string): Set<string> {
  const set = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hashIdx = line.indexOf("#");
    if (hashIdx < 0) continue;
    const name = line.slice(0, hashIdx).trim();
    const reason = line.slice(hashIdx + 1).trim();
    if (name && reason) set.add(name.toLowerCase());
  }
  return set;
}
