import { Logo } from "@/components/branding/Logo";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <Logo height={56} />
      <p className="text-muted-foreground">AI Travel Concierge</p>
    </main>
  );
}
