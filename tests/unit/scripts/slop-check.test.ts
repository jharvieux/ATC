// #1795 — unit tests for the D-091 slop-reduction diff scanner.
//
// scanFile()/emitMarkdown() are the pure, git-free halves of slop-check.ts
// (getChangedFiles/getAddedLinesForFile shell out to git and stay untested
// here, same split as check-d091-anti-patterns.ts's detectors vs its file
// walker). Each detector is pinned on both the anti-pattern it must catch
// and the discrimination boundary it must NOT flag — a detector with a
// dropped regex or broken backreference should fail these, not just stay
// silently quiet in CI.

import { describe, it, expect } from "vitest";
import { scanFile, emitMarkdown, type Finding } from "../../../scripts/slop-check";

function added(...lines: string[]): Map<number, string> {
  const m = new Map<number, string>();
  lines.forEach((l, i) => m.set(i + 1, l));
  return m;
}

function scan(...lines: string[]): Finding[] {
  const findings: Finding[] = [];
  scanFile("f.ts", added(...lines), findings);
  return findings;
}

describe("orphan-todo", () => {
  it("flags a bare // TODO with no owner or issue ref", () => {
    expect(scan("// TODO fix this later").map((f) => f.kind)).toEqual(["orphan-todo"]);
  });

  it("does NOT flag a TODO with an owner exemption — TODO(name)", () => {
    expect(scan("// TODO(jharvieux) revisit after #1234")).toEqual([]);
  });

  it("does NOT flag a TODO with an issue-ref exemption — TODO(#123)", () => {
    expect(scan("// TODO(#123) revisit")).toEqual([]);
  });

  it("flags FIXME/XXX/HACK the same way as TODO", () => {
    const findings = scan("// FIXME this is broken", "// XXX hack around it", "// HACK temp workaround");
    expect(findings.map((f) => f.kind)).toEqual(["orphan-todo", "orphan-todo", "orphan-todo"]);
  });
});

describe("narrating-comment", () => {
  it("flags a short verb-prefixed comment that narrates the next line", () => {
    expect(scan("// fetch the user").map((f) => f.kind)).toEqual(["narrating-comment"]);
  });

  it("does NOT flag a directive comment (eslint-disable etc.)", () => {
    expect(scan("// eslint-disable-next-line no-unused-vars")).toEqual([]);
  });

  it("does NOT flag a spec-reference comment (§ marker)", () => {
    expect(scan("// §17.9 CCPA export rate limit")).toEqual([]);
  });

  it("does NOT flag a comment explaining WHY (not verb-prefixed narration)", () => {
    expect(scan("// Retry here because the upstream API is flaky under load")).toEqual([]);
  });
});

describe("rethrow-catch", () => {
  it("flags a catch block that just re-throws the same variable", () => {
    const findings = scan("try {", "  doWork();", "} catch (err) {", "  throw err;", "}");
    expect(findings.map((f) => f.kind)).toEqual(["rethrow-catch"]);
  });

  it("does NOT flag when a DIFFERENT variable is thrown — the \\1 backreference is load-bearing", () => {
    // Rethrowing a wrapped/different error is intentional error handling, not
    // a no-op catch — the regex's backreference must distinguish this.
    const findings = scan("try {", "  doWork();", "} catch (err) {", "  throw new Error(`wrapped: ${err}`);", "}");
    expect(findings).toEqual([]);
  });

  it("does NOT flag a catch block that does real handling before rethrowing", () => {
    const findings = scan(
      "try {", "  doWork();", "} catch (err) {", "  console.error(err);", "  handleFailure(err);", "}",
    );
    expect(findings).toEqual([]);
  });
});

describe("wrapper-fn", () => {
  it("flags a single-expression export wrapper function", () => {
    const findings = scan("export function getName(user) { return user.name; }");
    expect(findings.map((f) => f.kind)).toEqual(["wrapper-fn"]);
  });

  it("does NOT flag a wrapper with a method-call predicate guard (not a pure passthrough)", () => {
    // A wrapper whose body is a guard + call rather than a bare single-statement
    // `return <expr>;` reads as intentional API surface, not slop — verifies the
    // regex doesn't over-match multi-statement or guarded bodies.
    const findings = scan(
      "export function isReady(x) {",
      "  if (!x) return false;",
      "  return x.status === \"ready\";",
      "}",
    );
    expect(findings).toEqual([]);
  });

  it("does NOT flag a non-exported single-expression function", () => {
    const findings = scan("function getName(user) { return user.name; }");
    expect(findings).toEqual([]);
  });
});

describe("emitMarkdown", () => {
  it("reports clean when there are no findings", () => {
    const md = emitMarkdown([]);
    expect(md).toContain("Slop check — clean");
    expect(md).not.toContain("findings");
  });

  it("groups findings by kind and includes file:line for each", () => {
    const findings: Finding[] = [
      { file: "a.ts", line: 3, kind: "orphan-todo", message: "Orphan TODO marker.", snippet: "// TODO fix" },
      { file: "b.ts", line: 9, kind: "rethrow-catch", message: "try/catch that just re-throws.", snippet: "throw err;" },
    ];
    const md = emitMarkdown(findings);
    expect(md).toContain("a.ts:3");
    expect(md).toContain("b.ts:9");
    expect(md).toContain("Orphan TODO/FIXME");
    expect(md).toContain("try/catch that just re-throws");
  });
});
