// Pure logic for the ambiguous-embed CI gate.
//
// PostgREST FK embeds (`.select("related_table(cols)")`) are ambiguous when
// the base table has multiple foreign keys pointing to the same referenced
// table. PostgREST picks one FK arbitrarily (or errors); the fix is to use
// the `!constraint_name` hint, e.g. `.select("related_table!fk_name(cols)")`.
//
// `!inner` and `!left` are JOIN MODIFIERS, not disambiguation hints — they
// pick join type, not which FK to follow. Any other `!xxx` suffix IS treated
// as a constraint-name hint and satisfies the check.
//
// This module answers mechanically: "does any `.from("t").select(...)` embed
// a table for which `t` has 2+ FK relationships to that target, without a
// non-join-modifier `!` hint?"
//
// Incident reference: issue #1134 — two FKs from contact_relationships to
// contacts (from_contact_id, to_contact_id) made embeds ambiguous.
//
// I/O lives in the orchestrator script; this module is pure.

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
  baseTable: string;
  embeddedTable: string;
  snippet: string;
  knownConstraints: string[];
}

// PostgREST join-type modifiers — NOT FK disambiguation hints.
const JOIN_MODIFIERS = new Set(["inner", "left"]);

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");
}

interface FkEntry {
  constraintName: string; // explicit name, or "{base}_{col}_fkey" for inline
  baseTable: string;
  referencedTable: string;
}

// Parse all FK relationships from migration files (filename-sorted order).
// Handles:
//   1. Named in CREATE TABLE:  CONSTRAINT name FOREIGN KEY (col) REFERENCES target
//   2. Inline in CREATE TABLE: col TYPE REFERENCES public.target(id)
//   3. Named in ALTER TABLE:   ADD CONSTRAINT name FOREIGN KEY (col) REFERENCES target
//   4. Unnamed in ALTER TABLE: ADD FOREIGN KEY (col) REFERENCES target
//   5. DROP TABLE — removes all previously-accumulated FKs for that table so
//      provisional tables that get dropped and recreated don't produce phantom
//      duplicate FK entries (e.g. the two-step email_log replacement pattern).
export function parseFKRelationships(migrations: Migration[]): FkEntry[] {
  const result: FkEntry[] = [];
  let anonIdx = 0;

  for (const m of migrations) {
    const norm = normalize(m.content);
    const stmts = norm.split(";").map((s) => s.trim()).filter(Boolean);

    for (const stmt of stmts) {
      // ── DROP TABLE — purge previously-accumulated FKs for this table ─────
      const dropMatch =
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/i.exec(stmt);
      if (dropMatch && !/ALTER/.test(stmt)) {
        const dropped = dropMatch[1].toLowerCase();
        let i = result.length - 1;
        while (i >= 0) {
          if (result[i].baseTable === dropped) result.splice(i, 1);
          i--;
        }
        continue;
      }

      // ── ALTER TABLE context ──────────────────────────────────────────────
      const alterMatch = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/i.exec(stmt);
      if (alterMatch) {
        const baseTable = alterMatch[1].toLowerCase();

        // ADD CONSTRAINT name FOREIGN KEY (col) REFERENCES target
        const namedRe =
          /ADD\s+CONSTRAINT\s+([a-z_][a-z0-9_]*)\s+FOREIGN\s+KEY\s*\([^)]+\)\s+REFERENCES\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
        let nm: RegExpExecArray | null;
        while ((nm = namedRe.exec(stmt)) !== null) {
          result.push({
            constraintName: nm[1].toLowerCase(),
            baseTable,
            referencedTable: nm[2].toLowerCase(),
          });
        }

        // ADD FOREIGN KEY (col) REFERENCES target (no CONSTRAINT keyword)
        const unnamedRe =
          /ADD\s+(?!CONSTRAINT\s)FOREIGN\s+KEY\s*\([^)]+\)\s+REFERENCES\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
        let um: RegExpExecArray | null;
        while ((um = unnamedRe.exec(stmt)) !== null) {
          result.push({
            constraintName: `__anon_${anonIdx++}`,
            baseTable,
            referencedTable: um[1].toLowerCase(),
          });
        }

        continue; // ALTER TABLE statement done
      }

      // ── CREATE TABLE context ─────────────────────────────────────────────
      const createMatch =
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/i.exec(stmt);
      if (!createMatch) continue;
      const baseTable = createMatch[1].toLowerCase();

      // Named: CONSTRAINT name FOREIGN KEY (col) REFERENCES target
      const namedRe =
        /CONSTRAINT\s+([a-z_][a-z0-9_]*)\s+FOREIGN\s+KEY\s*\([^)]+\)\s+REFERENCES\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
      let nm: RegExpExecArray | null;
      while ((nm = namedRe.exec(stmt)) !== null) {
        result.push({
          constraintName: nm[1].toLowerCase(),
          baseTable,
          referencedTable: nm[2].toLowerCase(),
        });
      }

      // Inline: col TYPE ... REFERENCES public.target
      // Constraint name follows PostgreSQL convention: {table}_{col}_fkey
      // We find each column that has REFERENCES by looking at each comma-separated
      // definition within the CREATE TABLE body.
      const bodyStart = stmt.indexOf("(", createMatch.index + createMatch[0].length);
      if (bodyStart < 0) continue;
      const body = stmt.slice(bodyStart + 1);

      // Split body on commas that are NOT inside nested parens
      const defs = splitOnTopLevelCommas(body);
      for (const def of defs) {
        if (/\bCONSTRAINT\b/i.test(def)) continue; // already handled as named
        if (!/\bREFERENCES\b/i.test(def)) continue;

        const refMatch = /\bREFERENCES\s+(?:public\.)?([a-z_][a-z0-9_]*)/i.exec(def);
        if (!refMatch) continue;

        // Extract column name: first word-run at the start of the trimmed def
        const colMatch = /^\s*([a-z_][a-z0-9_]*)/i.exec(def);
        const colName = colMatch ? colMatch[1].toLowerCase() : `__col_${anonIdx++}`;
        result.push({
          constraintName: `${baseTable}_${colName}_fkey`,
          baseTable,
          referencedTable: refMatch[1].toLowerCase(),
        });
      }
    }
  }

  return result;
}

// Split `s` on commas that are not inside parentheses.
function splitOnTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      if (depth === 0) break; // end of CREATE TABLE body
      depth--;
    } else if (s[i] === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) parts.push(s.slice(start));
  return parts;
}

// Build ambiguity map: baseTable → referencedTable → constraint names[]
// Only pairs with 2+ constraints are truly ambiguous.
export function buildAmbiguityMap(fks: FkEntry[]): Map<string, Map<string, string[]>> {
  const map = new Map<string, Map<string, string[]>>();
  for (const fk of fks) {
    if (!map.has(fk.baseTable)) map.set(fk.baseTable, new Map());
    const inner = map.get(fk.baseTable)!;
    if (!inner.has(fk.referencedTable)) inner.set(fk.referencedTable, []);
    inner.get(fk.referencedTable)!.push(fk.constraintName);
  }
  return map;
}

// Parse embedded table references from a PostgREST `.select("...")` argument.
// e.g. `"tier_definitions!inner(code), contacts!fk_name(id)"` →
//   [{ table: "tier_definitions", hint: "inner" },
//    { table: "contacts", hint: "fk_name" }]
export function parseSelectEmbeds(
  selectArg: string,
): Array<{ table: string; hint: string | null }> {
  const results: Array<{ table: string; hint: string | null }> = [];
  // Match: identifier, optional !hint, then ( — the paren is what makes it an embed
  const embedRe = /\b([a-z_][a-z0-9_]*)(?:!([a-z_][a-z0-9_]*))?(?=\s*\()/gi;
  let m: RegExpExecArray | null;
  while ((m = embedRe.exec(selectArg)) !== null) {
    results.push({
      table: m[1].toLowerCase(),
      hint: m[2]?.toLowerCase() ?? null,
    });
  }
  return results;
}

const FROM_RE = /\.from\(\s*["'](?:public\.)?([a-z_][a-z0-9_]*)["']\s*\)/gi;
// Match .select("...") including template literals and multi-line strings.
// Captures the quote character (group 1) and content (group 2).
const SELECT_RE = /\.select\(\s*(["'`])([\s\S]*?)\1\s*[,)]/g;

export function findViolations(
  ambiguityMap: Map<string, Map<string, string[]>>,
  sources: SourceFile[],
): Violation[] {
  const violations: Violation[] = [];

  for (const src of sources) {
    const { content } = src;
    FROM_RE.lastIndex = 0;
    const froms: Array<{ index: number; table: string }> = [];
    let fm: RegExpExecArray | null;
    while ((fm = FROM_RE.exec(content)) !== null) {
      froms.push({ index: fm.index, table: fm[1].toLowerCase() });
    }

    for (let i = 0; i < froms.length; i++) {
      const { index, table } = froms[i];
      const innerMap = ambiguityMap.get(table);
      if (!innerMap) continue;

      const nextFrom = i + 1 < froms.length ? froms[i + 1].index : content.length;
      const windowEnd = Math.min(nextFrom, index + 1500, content.length); // 1500-char lookahead per .from() chain
      const window = content.slice(index, windowEnd);

      SELECT_RE.lastIndex = 0;
      let sm: RegExpExecArray | null;
      while ((sm = SELECT_RE.exec(window)) !== null) {
        const selectArg = sm[2];
        const embeds = parseSelectEmbeds(selectArg);
        for (const embed of embeds) {
          const constraints = innerMap.get(embed.table);
          if (!constraints || constraints.length < 2) continue;
          // A non-join-modifier `!hint` disambiguates — check passes
          if (embed.hint !== null && !JOIN_MODIFIERS.has(embed.hint)) continue;

          const absoluteIdx = index + sm.index;
          const lineNum = content.slice(0, absoluteIdx).split("\n").length;
          const lineStart = content.lastIndexOf("\n", absoluteIdx) + 1;
          let lineEnd = content.indexOf("\n", absoluteIdx);
          if (lineEnd < 0) lineEnd = content.length;
          violations.push({
            file: src.file,
            line: lineNum,
            baseTable: table,
            embeddedTable: embed.table,
            snippet: content.slice(lineStart, lineEnd).trim(),
            knownConstraints: constraints,
          });
        }
      }
    }
  }
  return violations;
}
