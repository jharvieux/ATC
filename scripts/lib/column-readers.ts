// Pure logic for the column-reader CI gate.
//
// Companion to dropped-column-readers.ts. That module catches columns that
// were DROPPED by a migration; this one catches columns that were NEVER on
// the table — the class that caused #1183 (tenants.tier, which doesn't
// exist; tenant tier is stored as tier_id FK).
//
// Approach: parse every migration in filename order to build the live column
// set for each table (CREATE TABLE column lists + ALTER TABLE ADD/DROP/RENAME
// ops). Then scan source files for `.select("col, ...")` strings anchored to
// `.from("<table>")` calls and flag column names absent from the live set.
//
// Known limits (documented, not hidden):
//   - `.select("*")` is skipped — wildcard readers are not checkable here.
//   - Embedded resources (`.select("rel(col)")`) are skipped — they reference
//     a related table's columns, not the base table's.
//   - JSON operators (`col->key`) and modifiers (`!inner`) are skipped.
//   - Views, temp tables, and tables from schemas other than public are not
//     parsed from migrations — queries against them skip the check (no false
//     positives, but also no coverage).

import type { Migration, SourceFile, Violation } from "./dropped-column-readers";

export type { Migration, SourceFile, Violation };

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");
}

// Split a string on `sep` character at depth 0 (ignores occurrences inside parens).
function splitAtDepthZero(s: string, sep: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === sep && depth === 0) {
      result.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(s.slice(start).trim());
  return result.filter(Boolean);
}

const CONSTRAINT_KW = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|LIKE|INHERITS|INDEX|EXCLUDE)\b/i;

// Build the complete live-column set for every table across all migrations,
// processing them in filename (chronological) order.
export function computeLiveColumns(migrations: Migration[]): Map<string, Set<string>> {
  const live = new Map<string, Set<string>>();

  for (const m of migrations) {
    const norm = normalize(m.content);

    // 1. CREATE TABLE — seed the column set for the table.
    const createRe =
      /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
    let cm: RegExpExecArray | null;
    while ((cm = createRe.exec(norm)) !== null) {
      const table = cm[1].toLowerCase();
      const bodyStart = cm.index + cm[0].length;
      let depth = 1;
      let i = bodyStart;
      while (i < norm.length && depth > 0) {
        if (norm[i] === "(") depth++;
        else if (norm[i] === ")") depth--;
        i++;
      }
      const body = norm.slice(bodyStart, i - 1);
      const items = splitAtDepthZero(body, ",");
      if (!live.has(table)) live.set(table, new Set());
      const cols = live.get(table)!;
      for (const item of items) {
        if (CONSTRAINT_KW.test(item.trimStart())) continue;
        const tok = /^([a-z_][a-z0-9_]*)/i.exec(item.trimStart());
        if (tok) cols.add(tok[1].toLowerCase());
      }
    }

    // 2. ALTER TABLE — apply ADD/DROP/RENAME ops in statement order.
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
        live.get(table)?.delete(d[1].toLowerCase());
      }

      const addRe = /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
      let a: RegExpExecArray | null;
      while ((a = addRe.exec(stmt)) !== null) {
        if (!live.has(table)) live.set(table, new Set());
        live.get(table)!.add(a[1].toLowerCase());
      }

      const renameRe =
        /\bRENAME\s+COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*)/gi;
      let r: RegExpExecArray | null;
      while ((r = renameRe.exec(stmt)) !== null) {
        live.get(table)?.delete(r[1].toLowerCase());
        if (!live.has(table)) live.set(table, new Set());
        live.get(table)!.add(r[2].toLowerCase());
      }
    }
  }

  return live;
}

// Parse a Supabase `.select()` argument into bare column names, skipping
// wildcards, embedded resources (have parens), JSON operators, and modifiers.
export function parseSelectColumns(selectArg: string): string[] {
  const cols: string[] = [];
  for (const raw of splitAtDepthZero(selectArg, ",")) {
    const t = raw.trim();
    if (!t || t === "*") continue;
    if (t.startsWith("!")) continue; // e.g. !inner, !left
    if (t.includes("(")) continue; // embedded resource or aggregate
    if (t.includes("->")) continue; // JSON operator
    // Strip alias (col:alias → col) then take the identifier
    const base = t.includes(":") ? t.slice(0, t.indexOf(":")).trim() : t;
    const ident = /^([a-z_][a-z0-9_]*)/i.exec(base);
    if (ident) cols.push(ident[1].toLowerCase());
  }
  return cols;
}

// Regex anchors: `.from("table")` and `.select("col, ...")`.
// The select regex intentionally stops at the first quote char so it handles
// both double-quoted and single-quoted strings without overfitting.
const FROM_RE = /\.from\(\s*["'](?:public\.)?([a-z_][a-z0-9_]*)["']\s*\)/gi;
// Matches .select( followed by a quoted string (first arg only).
const SELECT_RE = /\.select\(\s*["']([^"']*)["']/g;

const WINDOW_CHARS = 800;

export function findSelectViolations(
  live: Map<string, Set<string>>,
  sources: SourceFile[],
): Violation[] {
  const violations: Violation[] = [];

  for (const src of sources) {
    const content = src.content;

    // Collect all .from("table") positions in this file.
    const froms: Array<{ table: string; index: number }> = [];
    FROM_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FROM_RE.exec(content)) !== null) {
      froms.push({ table: fm[1].toLowerCase(), index: fm.index });
    }

    for (let i = 0; i < froms.length; i++) {
      const { table, index } = froms[i];
      const liveCols = live.get(table);
      // Skip unknown tables (views, temp tables, non-public schema) — no false positives.
      if (!liveCols || liveCols.size === 0) continue;

      const hardCap = index + WINDOW_CHARS;
      const nextFrom = i + 1 < froms.length ? froms[i + 1].index : content.length;
      const windowEnd = Math.min(nextFrom, hardCap, content.length);
      const windowText = content.slice(index, windowEnd);

      SELECT_RE.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = SELECT_RE.exec(windowText)) !== null) {
        for (const col of parseSelectColumns(sm[1])) {
          if (liveCols.has(col)) continue;

          const absoluteIdx = index + sm.index;
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
  }

  return violations;
}

// Exceptions file format: `table.column # reason` (reason required).
// Mirrors dropped-column-readers.ts parseExceptions exactly.
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
