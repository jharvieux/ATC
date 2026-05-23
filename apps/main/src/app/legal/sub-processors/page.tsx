// §25.5 — Sub-processors disclosure.
//
// Public static page (no auth) listing every vendor that processes
// customer data on the platform's behalf, with the data category.
// Reviewed annually by the subprocessors-annual-review Inngest cron.

const SUBPROCESSORS = [
  {
    vendor: "Anthropic",
    category: "AI inference (Claude — chat responses, content extraction, hate-speech heuristic)",
    region: "United States",
  },
  {
    vendor: "OpenAI",
    category: "AI image generation (DALL-E — group hero images, optional)",
    region: "United States",
  },
  {
    vendor: "Supabase",
    category: "Database, authentication, file storage (RAG submissions), pgvector",
    region: "United States",
  },
  {
    vendor: "Vercel",
    category: "Application hosting and edge compute",
    region: "United States",
  },
  {
    vendor: "Stripe",
    category: "Payment processing (subscriptions, Connect for commission payouts)",
    region: "United States",
  },
  {
    vendor: "Resend",
    category: "Transactional and marketing email delivery",
    region: "United States",
  },
  {
    vendor: "Inngest",
    category: "Background job orchestration (webhooks, retries, scheduled tasks)",
    region: "United States",
  },
  {
    vendor: "Sentry",
    category: "Error tracking (PII scrubbed via beforeSend hook)",
    region: "United States",
  },
] as const;

export default function SubProcessorsPage(): JSX.Element {
  return (
    <main style={{ padding: 24, maxWidth: 880, margin: "0 auto", lineHeight: 1.5 }}>
      <h1>Sub-processors</h1>
      <p>
        We engage the following sub-processors to deliver platform services.
        Each one is contractually bound to process customer data only as
        directed by AI Travel Concierge and only for the purpose listed.
      </p>
      <p style={{ color: "#555", fontSize: 14 }}>
        This list is reviewed annually (January 1) and updated whenever a new
        vendor is onboarded. See <a href="/legal/privacy">Privacy policy</a> for
        the full data handling commitments.
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
        <thead>
          <tr style={{ background: "#f3f4f6" }}>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Vendor</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Category</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Region</th>
          </tr>
        </thead>
        <tbody>
          {SUBPROCESSORS.map((s) => (
            <tr key={s.vendor}>
              <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6", fontWeight: 600 }}>{s.vendor}</td>
              <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>{s.category}</td>
              <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>{s.region}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: 32, color: "#6b7280", fontSize: 13 }}>
        Last reviewed: TODO(operator) — bump after each annual review.
      </p>
    </main>
  );
}
