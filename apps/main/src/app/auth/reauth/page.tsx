// §17.7 — Sensitive-operations re-auth page.
// Shown when a sensitive route detects a session older than 4 hours.
// Re-initiates the OAuth flow and returns to the original page.

export default function ReauthPage({ searchParams }: { searchParams: Record<string, string> }): React.ReactElement {
  const returnTo = searchParams.return ?? "/";

  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Session expired</h1>
      <p style={{ color: "#6b7280", maxWidth: 380, textAlign: "center" }}>
        For security, this action requires you to sign in again. You&apos;ll be returned to where you
        were after signing in.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 280 }}>
        <a
          href={`/api/auth/oauth-initiate?provider=google&redirect_to=${encodeURIComponent(returnTo)}`}
          style={{ padding: "12px 16px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", textAlign: "center", textDecoration: "none", fontSize: 14, fontWeight: 500, color: "#111" }}
        >
          Continue with Google
        </a>
        <a
          href={`/api/auth/oauth-initiate?provider=azure&redirect_to=${encodeURIComponent(returnTo)}`}
          style={{ padding: "12px 16px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", textAlign: "center", textDecoration: "none", fontSize: 14, fontWeight: 500, color: "#111" }}
        >
          Continue with Microsoft
        </a>
        <a
          href={`/api/auth/oauth-initiate?provider=facebook&redirect_to=${encodeURIComponent(returnTo)}`}
          style={{ padding: "12px 16px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", textAlign: "center", textDecoration: "none", fontSize: 14, fontWeight: 500, color: "#111" }}
        >
          Continue with Facebook
        </a>
      </div>
    </main>
  );
}
