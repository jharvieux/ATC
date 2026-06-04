// Find-my-agent quiz. Server shell + client quiz UI. The client form
// collects the user's selections, scores them against the catalog (in
// pure quiz.ts), and redirects to /agents/[winner-slug].

import { SiteHeader } from "@/components/site-header/SiteHeader";
import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import { AgentQuizClient } from "./AgentQuizClient";

export default async function AgentQuizPage() {
  const headerProps = await getSiteHeaderProps();
  return (
    <>
      <SiteHeader {...headerProps} />
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight">Find your agent</h1>
        <p className="mt-2 text-muted-foreground">
          Four quick questions. We&apos;ll match you with the specialist who fits the trip you want.
        </p>
        <AgentQuizClient />
      </main>
    </>
  );
}
