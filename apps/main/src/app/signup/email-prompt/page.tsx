// §17.2 Step 4 — no-email recovery: email-prompt page.
//
// Reached when an OAuth provider returns no email AND any provider-specific
// recovery (Microsoft Graph) also turns up nothing. Facebook with the email
// scope denied lands here too. The user types an email, receives a Resend
// verification code on the next step, and confirms ownership before their
// public.users row is created.

export default function EmailPromptPage(): React.ReactElement {
  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>One more step</h1>
      <p style={{ color: "#6b7280", maxWidth: 400, textAlign: "center" }}>
        Your sign-in provider didn&apos;t share an email address with us. Please
        enter your email so we can create your account and keep you updated on
        your bookings.
      </p>
      <EmailPromptForm />
    </main>
  );
}

function EmailPromptForm(): React.ReactElement {
  return (
    <form method="POST" action="/api/auth/microsoft-email-prompt" style={{ display: "flex", flexDirection: "column", gap: 16, width: 320 }}>
      <label style={{ fontSize: 14, fontWeight: 500 }}>
        Email address
        <input
          type="email"
          name="email"
          required
          placeholder="you@example.com"
          style={{ display: "block", marginTop: 6, width: "100%", padding: "10px 12px", border: "1px solid #d1d5db", borderRadius: 8, fontSize: 15 }}
        />
      </label>
      <button
        type="submit"
        style={{ padding: "12px 16px", background: "#3b82f6", color: "#fff", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer" }}
      >
        Send verification code
      </button>
    </form>
  );
}
