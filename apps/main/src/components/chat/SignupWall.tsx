// §24.8 — Signup wall when an anonymous identifier hits the limit.
// MUST NOT reveal which identifier hit.

export function SignupWall({ body }: { body: string }): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        padding: 20,
        background: "#eff6ff",
        border: "1px solid #bfdbfe",
        borderRadius: 8,
        margin: 16,
      }}
    >
      <p style={{ margin: "0 0 12px 0", color: "#1e3a8a", fontWeight: 600 }}>{body}</p>
      <a
        href="/signup"
        style={{
          display: "inline-block",
          background: "#2563eb",
          color: "#fff",
          padding: "10px 18px",
          borderRadius: 6,
          textDecoration: "none",
        }}
      >
        Sign up to keep chatting
      </a>
    </div>
  );
}
