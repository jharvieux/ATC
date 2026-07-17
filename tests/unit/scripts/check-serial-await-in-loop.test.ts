// Unit tests — serial-await-in-loop detector (#1951). Intent: flag per-iteration
// awaits in background-job loops (the N+1 pattern) WITHOUT false-flagging the
// cases that must stay serial-looking to a scanner: for-await async iteration,
// awaits already fanned out inside a callback, and awaits outside any loop.
import { describe, it, expect } from "vitest";
import {
  findSerialAwaitsInLoops,
  loadBaseline,
  diffAgainstBaseline,
  noFilesScannedMessage,
} from "../../../scripts/check-serial-await-in-loop";

const F = "apps/main/src/inngest/job.ts";

describe("findSerialAwaitsInLoops", () => {
  it("flags a for..of loop that awaits per iteration", () => {
    const r = findSerialAwaitsInLoops(F, `for (const x of items) {\n  await doWork(x);\n}`);
    expect(r).toHaveLength(1);
    expect(r[0]!.loopKind).toBe("for");
    expect(r[0]!.loopLine).toBe(1);
  });

  it("flags a while loop that awaits per iteration", () => {
    const r = findSerialAwaitsInLoops(F, `while (hasMore) {\n  const page = await fetchPage();\n}`);
    expect(r).toHaveLength(1);
    expect(r[0]!.loopKind).toBe("while");
  });

  it("does NOT flag for-await async iteration (the await is the loop protocol)", () => {
    expect(findSerialAwaitsInLoops(F, `for await (const x of stream) {\n  process(x);\n}`)).toEqual([]);
  });

  it("does NOT flag awaits fanned out inside a callback (a function scope intervenes)", () => {
    // This is the already-parallelized shape (Promise.all / mapWithConcurrency).
    const src = `await mapWithConcurrency(items, 10, async (x) => {\n  await doWork(x);\n});`;
    expect(findSerialAwaitsInLoops(F, src)).toEqual([]);
  });

  it("does NOT flag an await outside any loop", () => {
    expect(findSerialAwaitsInLoops(F, `async function run() {\n  await once();\n}`)).toEqual([]);
  });

  it("reports one finding per loop even with multiple awaits in the body", () => {
    const src = `for (const x of items) {\n  await a(x);\n  await b(x);\n}`;
    expect(findSerialAwaitsInLoops(F, src)).toHaveLength(1);
  });

  it("does not confuse braces inside template literals for scopes", () => {
    // The `${...}` and its braces must not be read as a block that hides the loop.
    const src = "for (const x of items) {\n  const msg = `hi ${x.name}`;\n  await send(msg);\n}";
    expect(findSerialAwaitsInLoops(F, src)).toHaveLength(1);
  });

  it("suppresses a loop marked serial-await-ok (on the line above)", () => {
    const src = `// serial-await-ok: time-budget drain, must stay serial (#1948)\nfor (const x of items) {\n  await doWork(x);\n}`;
    expect(findSerialAwaitsInLoops(F, src)).toEqual([]);
  });

  it("suppresses a loop marked serial-await-ok (inline on the header)", () => {
    const src = `for (const x of items) { // serial-await-ok: ordered writes\n  await doWork(x);\n}`;
    expect(findSerialAwaitsInLoops(F, src)).toEqual([]);
  });

  it("ignores test files and non-ts", () => {
    expect(findSerialAwaitsInLoops("apps/main/src/x.test.ts", `for (const x of i) {\n await y(); \n}`)).toEqual([]);
    expect(findSerialAwaitsInLoops("apps/main/src/x.css", `for (const x of i) {\n await y(); \n}`)).toEqual([]);
  });
});

// #1985 CI-gate additions — the baseline-diffing logic decides pass/fail, so a
// regression here would either mask new serial-await sites (silently widening
// the baseline) or spuriously fail every PR that touches a baselined file.
describe("diffAgainstBaseline", () => {
  it("reports a file fresh when its live count exceeds its baselined count", () => {
    const live = new Map([["apps/main/src/inngest/job.ts", 2]]);
    const baseline = new Map([["apps/main/src/inngest/job.ts", 1]]);
    const { fresh } = diffAgainstBaseline(live, baseline);
    expect(fresh).toEqual([{ file: "apps/main/src/inngest/job.ts", excess: 1 }]);
  });

  it("reports nothing fresh when the live count exactly matches the baseline", () => {
    const live = new Map([["apps/main/src/inngest/job.ts", 3]]);
    const baseline = new Map([["apps/main/src/inngest/job.ts", 3]]);
    expect(diffAgainstBaseline(live, baseline).fresh).toEqual([]);
  });

  it("fails closed: with an empty baseline (missing file), every live finding is fresh", () => {
    const live = new Map([
      ["apps/main/src/inngest/job.ts", 2],
      ["apps/main/src/lib/cron/sweep.ts", 1],
    ]);
    const { fresh } = diffAgainstBaseline(live, new Map());
    expect(fresh.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "apps/main/src/inngest/job.ts", excess: 2 },
      { file: "apps/main/src/lib/cron/sweep.ts", excess: 1 },
    ]);
  });

  it("flags a baseline entry as stale when the live count drops below it", () => {
    const baseline = new Map([["apps/main/src/inngest/job.ts", 5]]);
    const { stale } = diffAgainstBaseline(new Map(), baseline);
    expect(stale).toEqual([["apps/main/src/inngest/job.ts", 5]]);
  });
});

describe("loadBaseline", () => {
  it("returns an empty map when the baseline file does not exist (fail-closed)", () => {
    expect(loadBaseline("/nonexistent/path/does-not-exist-1985.txt")).toEqual(new Map());
  });
});

describe("noFilesScannedMessage — #1985 BLOCKER: fail loud on zero files scanned", () => {
  it("returns an error message when zero files were scanned (renamed/moved dirs)", () => {
    expect(noFilesScannedMessage(0)).toMatch(/no files found under scanned dirs/);
  });

  it("returns null when at least one file was scanned", () => {
    expect(noFilesScannedMessage(1)).toBeNull();
  });
});
