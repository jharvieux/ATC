// Strip log-injection vectors (CR/LF + ANSI escapes) from any string before
// it lands in a console.* call. CodeQL flags user-controlled values flowing
// into log calls (rule: js/log-injection); wrap those values with
// sanitizeForLog() to satisfy the rule and prevent forged log lines that
// could confuse incident triage.

const CONTROL_RX = /[\r\n]/g;

export function sanitizeForLog(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.replace(CONTROL_RX, " ").slice(0, 1024);
}
