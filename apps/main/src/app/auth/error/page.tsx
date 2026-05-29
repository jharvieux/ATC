// OAuth error page. The auth callback (§17.1–17.3) redirects here with
// ?message=<reason> when the provider returns an error or Supabase rejects
// the session exchange. Without this route those redirects 404.

export default async function AuthErrorPage(props: {
  searchParams: Promise<Record<string, string>>;
}): Promise<React.ReactElement> {
  const searchParams = await props.searchParams;
  // `message` is URL-controllable; render it as escaped text only (never HTML)
  // and cap its length so a crafted link can't fill the page with arbitrary copy.
  const message = (searchParams.message ?? "").slice(0, 200);

  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: 20, fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Sign-in problem</h1>
      <p style={{ color: "#6b7280", maxWidth: 420, textAlign: "center" }}>
        We couldn&apos;t complete your sign-in. Please try again — if it keeps happening, contact
        support.
      </p>
      {message && (
        <p style={{ color: "#9ca3af", maxWidth: 420, textAlign: "center", fontSize: 13 }}>{message}</p>
      )}
      <a
        href="/signup"
        style={{ padding: "12px 16px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", textAlign: "center", textDecoration: "none", fontSize: 14, fontWeight: 500, color: "#111", width: 280 }}
      >
        Back to sign in
      </a>
    </main>
  );
}
