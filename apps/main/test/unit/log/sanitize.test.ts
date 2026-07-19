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

  // #103 — the chat [chat:perf] sink logs sanitizeForLog(conversationId) with a
  // local \r\n barrier (apps/main/src/app/api/chat/route.ts:474). Pin that a
  // crafted conversation_id can't smuggle a line terminator into the log and
  // forge a second [chat:perf] entry. Asserts on sanitizeForLog's own output
  // directly (no extra .replace in the assertion) so a CONTROL_CHARS
  // regression here actually fails the test instead of being masked by a
  // redundant strip performed by the test itself.
  it("#103 chat log sink single-lines a CRLF-laden conversation id", () => {
    const forged = "abc\r\n[chat:perf] config_db_reads=0 conversation_id=admin";
    expect(sanitizeForLog(forged)).not.toMatch(/[\r\n]/);
  });

  // #103 — the route-local barrier at chat/route.ts:474 re-applies
  // `.replace(/[\r\n]+/g, " ")` purely so CodeQL's taint tracker recognizes a
  // barrier at the sink (its cross-module helper model misses sanitizeForLog).
  // Pin that it's a true runtime no-op on already-sanitized text, not a
  // silent behavior change at the sink.
  it("#103 route-local barrier is a no-op on already-sanitized text", () => {
    const forged = "abc\r\n[chat:perf] config_db_reads=0 conversation_id=admin";
    const sanitized = sanitizeForLog(forged);
    expect(sanitized.replace(/[\r\n]+/g, " ")).toBe(sanitized);
  });
});
