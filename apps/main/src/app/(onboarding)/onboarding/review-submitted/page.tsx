// §15.10 — Onboarding Stage 11: Awaiting review.
// Static server component — no data fetch needed.

export default function OnboardingReviewSubmittedPage() {
  return (
    <div className="max-w-xl mx-auto py-10 px-4 text-center">
      <div className="text-5xl mb-4">🎉</div>
      <h1 className="text-2xl font-semibold mb-4">Application Submitted!</h1>
      <p className="text-gray-600 mb-4">
        Thank you for completing the onboarding process. Our compliance team will
        review your application within <strong>3 business days</strong>.
      </p>
      <p className="text-gray-600 mb-8">
        You will receive an email notification when a decision has been made.
        If we need additional information, we will reach out to your support email.
      </p>
      <p className="text-sm text-gray-400">
        Questions? Contact us at{" "}
        <a href="mailto:support@aitravelconcierge.com" className="underline">
          support@aitravelconcierge.com
        </a>
      </p>
    </div>
  );
}
