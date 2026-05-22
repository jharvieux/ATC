// §11.6 — Transfer consent page (server wrapper).
// Wraps the client component in Suspense so useSearchParams() doesn't
// cause a prerender error in Next.js 14 (route segment config `dynamic`
// is ignored in "use client" files).

import { Suspense } from "react";
import { TransferConsentClient } from "./TransferConsentClient";

export default function TransferConsentPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center">Loading…</div>}>
      <TransferConsentClient />
    </Suspense>
  );
}
