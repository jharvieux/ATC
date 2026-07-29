// Default chat route — no agent slug, falls back to the tenant's default
// persona. Per-agent chat is at /chat/[slug].
//
// Anonymous visitors on the platform domain get redirected to the Booking
// tenant subdomain so a real tenant resolves (#699).

import type { Metadata } from "next";
import { ChatExperience } from "@/components/chat/ChatExperience";
import { redirectPlatformChatToBooking } from "@/lib/chat/platform-redirect";
import { NOINDEX_FOLLOW } from "@/lib/seo/site";

// Live chat surface, not a landing page — and on the platform domain it
// redirects to the Booking tenant, so it has no canonical apex URL.
export const metadata: Metadata = { robots: NOINDEX_FOLLOW };

export default async function ChatPage() {
  await redirectPlatformChatToBooking("");
  return (
    <div className="h-screen">
      <ChatExperience />
    </div>
  );
}
