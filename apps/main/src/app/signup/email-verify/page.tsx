// §17.2 Step 5 — no-email recovery: OTP entry.
//
// Reached from /api/auth/microsoft-email-prompt after the OTP has been mailed.
// The user types the 6-digit code; POST → /api/auth/microsoft-email-verify
// validates it, creates the public.users row, and lands them on "/".

export default function EmailVerifyPage(): React.ReactElement {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Check your email</h1>
      <p style={{ color: "#6b7280", maxWidth: 400, textAlign: "center" }}>
        We sent a 6-digit verification code to the address you provided. Enter
        it below to finish signing in.
      </p>
      <form
        method="POST"
        action="/api/auth/microsoft-email-verify"
        style={{ display: "flex", flexDirection: "column", gap: 16, width: 320 }}
      >
        <label style={{ fontSize: 14, fontWeight: 500 }}>
          Verification code
          <input
            type="text"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            placeholder="123456"
            autoComplete="one-time-code"
            style={{
              display: "block",
              marginTop: 6,
              width: "100%",
              padding: "10px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              fontSize: 18,
              letterSpacing: "0.3em",
              textAlign: "center",
            }}
          />
        </label>
        <button
          type="submit"
          style={{
            padding: "12px 16px",
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Verify and continue
        </button>
      </form>
    </main>
  );
}
