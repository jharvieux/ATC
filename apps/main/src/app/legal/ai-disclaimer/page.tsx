// §17.6 — AI Liability Disclaimer page.
// Renders the current ai_disclaimer legal document.
// Includes state-specific appendix sections.

// #1792 — legal_documents has no tenant_id (platform-wide, not
// tenant-scoped or personalized) and changes only on an infrequent admin
// publish action, so a short ISR window trades a few minutes of staleness
// for cutting a DB read on every request. Same pattern as
// apps/main/src/app/agents/[slug]/page.tsx.
export const revalidate = 300;

import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { formatDate } from "@/lib/format-date";

export const metadata: Metadata = {
  title: "AI liability disclaimer",
  description:
    "How AI Travel Concierge discloses AI-assisted conversations, what the AI personas are and are not, and the limits of AI-generated travel guidance.",
  alternates: { canonical: "/legal/ai-disclaimer" },
};

async function getCurrentAiDisclaimer() {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("legal_documents")
    .select("version, content_markdown, effective_at")
    .eq("document_type", "ai_disclaimer")
    .is("superseded_at", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { version: number; content_markdown: string; effective_at: string } | null;
}

export default async function AiDisclaimerPage() {
  const doc = await getCurrentAiDisclaimer();

  if (!doc) {
    return (
      <div className="max-w-3xl mx-auto py-10 px-4">
        <h1 className="text-2xl font-bold mb-4">AI Liability Disclaimer</h1>
        <p className="text-gray-500">This document is not yet available. Please check back later.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-4">
      <p className="text-sm text-gray-400 mb-4">
        Version {doc.version} · Effective {formatDate(doc.effective_at)}
      </p>
      <div className="prose max-w-none whitespace-pre-wrap text-sm text-gray-800">
        {doc.content_markdown}
      </div>
      <div className="mt-8 p-4 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
        <strong>Notice:</strong> This conversation platform uses AI to assist with travel recommendations.
        AI-generated responses may contain errors. Always verify critical information with your travel professional.
      </div>
    </div>
  );
}
