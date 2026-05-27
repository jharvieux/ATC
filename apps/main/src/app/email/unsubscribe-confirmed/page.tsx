// §23.3 — Unsubscribe confirmation page.
// CAN-SPAM requires unsubscribe requests to be honored within 10 business days.
// The platform processes them immediately.

import Link from "next/link";

export default function UnsubscribeConfirmedPage() {
  return (
    <main style={{ maxWidth: 500, margin: "80px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif", textAlign: "center" }}>
      <h1 style={{ color: "#1f2937" }}>You&rsquo;ve been unsubscribed.</h1>
      <p style={{ color: "#6b7280", lineHeight: 1.7 }}>
        Your unsubscribe request has been processed. You won&rsquo;t receive further emails
        of that type from this agency.
      </p>
      <p style={{ color: "#6b7280", fontSize: 14 }}>
        You can manage your email preferences at any time from your account settings.
      </p>
      <Link
        href="/"
        style={{
          display: "inline-block",
          marginTop: 24,
          padding: "10px 20px",
          background: "#3b82f6",
          color: "#fff",
          borderRadius: 6,
          textDecoration: "none",
        }}
      >
        Back to home
      </Link>
    </main>
  );
}
