// #1412 — sanitizeForLog neutralizes user-derived values before logging.
//
// Pins the log-injection (CWE-117) guarantee: CR/LF and other control chars
// from request input can't forge or inject extra log lines. A regression that
// stopped stripping line terminators would fail these.

import { describe, it, expect } from "vitest";
import { sanitizeForLog } from "@/lib/log/sanitize";

const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);

describe("sanitizeForLog", () => {
  it("strips CR/LF so a value can't open a new log line", () => {
    const out = sanitizeForLog("ok\n[2026-01-01] [ADMIN] forged entry");
    expect(out.includes("\n")).toBe(false);
    expect(out.includes("\r")).toBe(false);
    expect(out).toBe("ok [2026-01-01] [ADMIN] forged entry");
  });

  it("collapses CRLF + tab runs to a single space", () => {
    expect(sanitizeForLog("a\r\n\t\tb")).toBe("a b");
  });

  it("strips NUL and DEL control chars", () => {
    expect(sanitizeForLog(`a${NUL}b${DEL}c`)).toBe("a b c");
  });

  it("leaves a clean string unchanged", () => {
    expect(sanitizeForLog("conversation 123 failed: timeout")).toBe(
      "conversation 123 failed: timeout",
    );
  });

  it("uses an Error's stack/message and single-lines it", () => {
    const err = new Error("boom\ninjected");
    const out = sanitizeForLog(err);
    expect(out.includes("\n")).toBe(false);
    expect(out).toContain("boom injected");
  });

  it("truncates past maxLen with a marker (bounds log size)", () => {
    const out = sanitizeForLog("x".repeat(50), 10);
    expect(out).toBe(`${"x".repeat(10)}...[truncated]`);
  });
});
