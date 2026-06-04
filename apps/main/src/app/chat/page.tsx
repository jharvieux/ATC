// Default chat route — no agent slug, falls back to the tenant's default
// persona. Per-agent chat lives at /chat/[slug] (Phase 5c).

import { ChatExperience } from "@/components/chat/ChatExperience";

export default function ChatPage() {
  return <ChatExperience />;
}
