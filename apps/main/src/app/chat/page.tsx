// Default chat route — no agent slug, falls back to the tenant's default
// persona. Per-agent chat lives at /chat/[slug] (Phase 5c).
//
// Anonymous visitors on the platform domain get redirected to the Booking
// tenant subdomain so a real tenant resolves (#699).

import { ChatExperience } from "@/components/chat/ChatExperience";
import { redirectPlatformChatToBooking } from "@/lib/chat/platform-redirect";

export default async function ChatPage() {
  await redirectPlatformChatToBooking("");
  return (
    <div className="h-screen">
      <ChatExperience />
    </div>
  );
}
