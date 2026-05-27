#!/usr/bin/env python3
"""
Codemod: wrap unchecked Supabase mutations with safeAwait(..., "context").

Usage:
  python3 scripts/codemod-safe-await.py <file1> [<file2> ...]

For each file:
  1. Reads ESLint violations (call eslint externally to get the line/col list).
  2. For each violation, finds the surrounding `await <expr>` statement and
     wraps `<expr>` with `safeAwait(<expr>, "<table>.<verb>")`.
  3. Adds an import of safeAwait if the file doesn't already have one.

Intentionally conservative:
  - Skips await expressions inside `safeAwait(...)` (already wrapped).
  - Skips await expressions whose result is destructured `const { ... } = await ...`.
  - Skips await expressions whose result is returned `return await ...`.
  - Skips await expressions that are arguments to another call.
  - Skips assignments `x = await ...` and variable-decl `const x = await ...`.
  - Only wraps when the await is the ENTIRE expression statement (matching
    the ESLint rule's flagging heuristic).

After running, run pnpm typecheck + pnpm lint to verify.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IMPORT_LINE = 'import { safeAwait } from "@/lib/db/safe-mutation";'


def detect_eslint_prefix(files):
    """Pick the closest apps/<name> directory whose .eslintrc loads the
    atc plugin. Falls back to apps/main."""
    for f in files:
        rel = Path(f).resolve()
        try:
            rel = rel.relative_to(REPO)
        except ValueError:
            continue
        parts = rel.parts
        if len(parts) >= 2 and parts[0] == "apps":
            app = parts[1]
            eslintrc = REPO / "apps" / app / ".eslintrc.json"
            if eslintrc.exists():
                return f"apps/{app}"
    return "apps/main"


def get_violations(files):
    """Run eslint and return list of {filePath, line, column}."""
    prefix = detect_eslint_prefix(files)
    cmd = [
        "npx", "--prefix", prefix, "eslint",
        "--rule", "atc/no-unchecked-supabase-mutation: error",
        "-f", "json",
    ] + files
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO)
    # eslint exits non-zero when there are violations — that's expected.
    if not result.stdout.strip():
        print(f"[codemod] eslint failed: {result.stderr}", file=sys.stderr)
        return []
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        print(f"[codemod] couldn't parse eslint json: {result.stdout[:500]}", file=sys.stderr)
        return []
    out = []
    for entry in data:
        for msg in entry.get("messages", []):
            if msg.get("ruleId") == "atc/no-unchecked-supabase-mutation":
                out.append({
                    "file": entry["filePath"],
                    "line": msg["line"],
                    "column": msg["column"],
                })
    return out


# Match `.from("table")` or `.from('table')` to extract the table name.
TABLE_RE = re.compile(r'\.from\(\s*["\']([a-zA-Z0-9_]+)["\']\s*\)')


def find_table_and_verb(snippet):
    """From an await expression snippet, extract table name + verb (insert/update/delete/upsert).
    Returns (table, verb) or (None, None)."""
    table_m = TABLE_RE.search(snippet)
    table = table_m.group(1) if table_m else None
    verb = None
    for v in ("insert", "update", "delete", "upsert"):
        if re.search(rf"\.{v}\s*\(", snippet):
            verb = v
            break
    return table, verb


def wrap_await_at(text, line, col):
    """Given source text and a 1-based (line, col) where ESLint flagged an
    `await` ExpressionStatement, wrap the whole awaited expression with
    safeAwait(..., "<table>.<verb>"). Returns (new_text, changed_bool).
    """
    lines = text.split("\n")
    if line - 1 >= len(lines):
        return text, False
    target_line = lines[line - 1]

    # ESLint reports column where `await` starts (1-based).
    idx_in_line = col - 1
    if idx_in_line >= len(target_line) or not target_line[idx_in_line:].startswith("await "):
        # Try to find `await` near the column (sometimes the rule reports the
        # outer statement column).
        m = re.search(r"\bawait\b", target_line)
        if not m:
            return text, False
        idx_in_line = m.start()

    # Absolute byte offset of `await ` start.
    line_offsets = [0]
    for ln in lines[:-1]:
        line_offsets.append(line_offsets[-1] + len(ln) + 1)
    start_abs = line_offsets[line - 1] + idx_in_line

    # `await` is 5 chars + 1 space = 6 to reach the start of the expression.
    expr_start = start_abs + len("await ")

    # Find the end of the awaited expression — it's terminated by `;` or
    # by the end of the line if the line ends mid-statement. To handle
    # multi-line chains we walk forward across `(` and matching `)`.
    paren_depth = 0
    bracket_depth = 0
    brace_depth = 0
    i = expr_start
    template_depth = 0
    in_string = None  # None or one of ' " `
    while i < len(text):
        c = text[i]
        if in_string:
            if c == "\\":
                i += 2
                continue
            if c == in_string:
                in_string = None
            i += 1
            continue
        if c in ("'", '"', "`"):
            in_string = c
            i += 1
            continue
        if c == "(":
            paren_depth += 1
        elif c == ")":
            paren_depth -= 1
            if paren_depth < 0:
                break
        elif c == "[":
            bracket_depth += 1
        elif c == "]":
            bracket_depth -= 1
        elif c == "{":
            brace_depth += 1
        elif c == "}":
            brace_depth -= 1
            if brace_depth < 0:
                break
        elif c == ";" and paren_depth == 0 and bracket_depth == 0 and brace_depth == 0:
            break
        elif c == "\n" and paren_depth == 0 and bracket_depth == 0 and brace_depth == 0:
            # newline at top depth: look ahead past whitespace + comments.
            # If the next significant char is `.` or `,` or `)` (chain
            # continuation or arg-list continuation), keep walking.
            # Otherwise end the statement here (e.g., next line starts a
            # new statement without a semicolon — rare but valid TS).
            look = i + 1
            while look < len(text) and text[look] in " \t":
                look += 1
            # skip line comments — they end at newline
            if look + 1 < len(text) and text[look:look+2] == "//":
                # End of comment is newline
                while look < len(text) and text[look] != "\n":
                    look += 1
                i = look
                continue
            if look < len(text) and text[look] in ".,)":
                # Continuation: keep walking.
                i = look
                continue
            # Otherwise treat the newline as statement terminator.
            break
        i += 1
    expr_end = i

    expr_text = text[expr_start:expr_end]

    # Extract table + verb for the context label.
    table, verb = find_table_and_verb(expr_text)
    if not table or not verb:
        return text, False
    context = f"{table}.{verb}"

    wrapped = f"safeAwait({expr_text}, \"{context}\")"
    new_text = text[:expr_start] + wrapped + text[expr_end:]
    return new_text, True


def ensure_import(text):
    """If the file doesn't already import safeAwait, add the import line
    after the last `import` statement at the top."""
    if "safeAwait" in text and "safe-mutation" in text:
        return text, False
    # Find the last `import` statement at the top of the file.
    lines = text.split("\n")
    last_import = -1
    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if stripped.startswith("import ") and ";" in ln:
            last_import = i
        elif stripped == "" or stripped.startswith("//") or stripped.startswith("/*"):
            continue
        elif last_import >= 0:
            break
    insert_at = last_import + 1 if last_import >= 0 else 0
    lines.insert(insert_at, IMPORT_LINE)
    return "\n".join(lines), True


def process_file(filepath, violations):
    """Process one file. violations is a sorted-by-line-desc list of
    {line, column} dicts."""
    text = Path(filepath).read_text()
    original = text

    # Sort violations DESCENDING by (line, col) so wrapping later sites
    # doesn't shift earlier sites' offsets.
    for v in sorted(violations, key=lambda x: (-x["line"], -x["column"])):
        text, changed = wrap_await_at(text, v["line"], v["column"])
        if not changed:
            print(f"[codemod] {filepath}:{v['line']}:{v['column']} — could not wrap", file=sys.stderr)
    if text != original:
        text, _ = ensure_import(text)
        Path(filepath).write_text(text)
        return True
    return False


def main():
    if len(sys.argv) < 2:
        print("usage: codemod-safe-await.py <file1> [<file2> ...]", file=sys.stderr)
        sys.exit(2)

    files = sys.argv[1:]
    violations = get_violations(files)
    if not violations:
        print("[codemod] no violations found", file=sys.stderr)
        sys.exit(0)

    by_file = {}
    for v in violations:
        by_file.setdefault(v["file"], []).append(v)

    n_changed = 0
    for fp, vs in sorted(by_file.items()):
        if process_file(fp, vs):
            n_changed += 1
            print(f"[codemod] migrated {fp.replace(str(REPO) + '/', '')} ({len(vs)} sites)")

    print(f"\n[codemod] changed {n_changed} file(s)")


if __name__ == "__main__":
    main()
