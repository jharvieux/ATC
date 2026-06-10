// §15.10 — Onboarding Stage 11: Awaiting review.
// Static server component — no data fetch needed.
//
// #960 — this page is ALSO the post-login landing while onboarding_stage is
// review_submitted (see lib/auth/post-login-destination.ts), so the copy must
// read correctly both right after submission AND on a later revisit while the
// application is still pending. Once approved, post-login routing sends the
// admin to /crm/contacts instead, so this page only renders for pending tenants.

export default function OnboardingReviewSubmittedPage() {
  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <div className="text-5xl mb-4 text-center">🎉</div>
      <h1 className="text-2xl font-semibold mb-2 text-center">
        Application submitted — under review
      </h1>
      <p className="text-gray-600 mb-8 text-center">
        Your application is with our compliance team. There is nothing more you
        need to do right now.
      </p>

      <h2 className="text-lg font-medium mb-2">What we received</h2>
      <ul className="list-disc pl-5 text-gray-600 mb-8 space-y-1">
        <li>Your agency profile and business details</li>
        <li>Accepted legal agreements and Independent Contractor Agreement</li>
        <li>Tax form and state of operation</li>
        <li>Plan selection and subscription setup</li>
        <li>Payout (Stripe) account setup</li>
      </ul>

      <h2 className="text-lg font-medium mb-2">What happens next</h2>
      <ol className="list-decimal pl-5 text-gray-600 mb-8 space-y-2">
        <li>
          Our compliance team reviews your application — typically within{" "}
          <strong>3 business days</strong>.
        </li>
        <li>
          You will receive an email with the decision:
          <ul className="list-disc pl-5 mt-1 space-y-1">
            <li>
              <strong>Approved</strong> — your account becomes active, your
              30-day trial starts, and the email includes a link to sign in to
              your agency portal.
            </li>
            <li>
              <strong>More information needed</strong> — the email tells you
              which step to revisit; sign back in to update it.
            </li>
          </ul>
        </li>
        <li>
          Once approved, sign in to start inviting agents and working with
          clients. If you skipped branding, you can finish it any time from
          your settings.
        </li>
      </ol>

      <p className="text-gray-600 mb-8">
        You can safely close this page. If you sign back in while the review is
        still pending, you will land here again — that simply means a decision
        has not been made yet.
      </p>

      <p className="text-sm text-gray-400 text-center">
        Questions? Contact us at{" "}
        <a href="mailto:support@ai-travelconcierge.com" className="underline">
          support@ai-travelconcierge.com
        </a>
      </p>
    </div>
  );
}
