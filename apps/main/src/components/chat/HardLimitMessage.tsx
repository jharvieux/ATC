// §24.9 — Hard-limit system message rendered when the customer hits the cap.
// NOT in-character — clearly platform-spoken.

export function HardLimitMessage({
  body,
  resetAt,
}: {
  body: string;
  resetAt: string;
}): JSX.Element {
  const resetPretty = new Date(resetAt).toLocaleDateString();
  return (
    <div
      role="alert"
      style={{
        margin: 16,
        padding: 20,
        background: "#fef3c7",
        border: "1px solid #f59e0b",
        borderRadius: 8,
        color: "#78350f",
      }}
    >
      <p style={{ margin: "0 0 8px 0", fontWeight: 700 }}>Chat limit reached</p>
      <p style={{ margin: "0 0 12px 0", whiteSpace: "pre-wrap" }}>{body}</p>
      <p style={{ margin: "0 0 16px 0", fontSize: 13 }}>Quota resets {resetPretty}.</p>
      <div style={{ display: "flex", gap: 10 }}>
        <a
          href="/api/chat/escalate"
          style={{
            background: "#1f2937",
            color: "#fff",
            padding: "8px 14px",
            borderRadius: 6,
            textDecoration: "none",
          }}
        >
          Talk to a human
        </a>
        <a
          href="/bookings"
          style={{
            background: "#fff",
            color: "#1f2937",
            border: "1px solid #1f2937",
            padding: "8px 14px",
            borderRadius: 6,
            textDecoration: "none",
          }}
        >
          View my bookings
        </a>
      </div>
    </div>
  );
}
