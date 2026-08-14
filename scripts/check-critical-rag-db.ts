import fs from "node:fs";
import { pathToFileURL } from "node:url";

interface CriticalRagDbContext {
  dbUrl: string | undefined;
  eventName: string | undefined;
  pullRequestAuthor: string | undefined;
}

export type CriticalRagDbDecision = "run" | "dependabot-exempt" | "fail";

export function criticalRagDbDecision({
  dbUrl,
  eventName,
  pullRequestAuthor,
}: CriticalRagDbContext): CriticalRagDbDecision {
  if (dbUrl?.trim()) return "run";
  if (eventName === "pull_request" && pullRequestAuthor === "dependabot[bot]") {
    return "dependabot-exempt";
  }
  return "fail";
}

function main(): void {
  const decision = criticalRagDbDecision({
    dbUrl: process.env.SUPABASE_RAG_DB_URL,
    eventName: process.env.GITHUB_EVENT_NAME,
    pullRequestAuthor: process.env.RAG_SCOPE_PR_AUTHOR,
  });
  if (decision === "fail") {
    console.error(
      "SUPABASE_RAG_DB_URL is required for critical RAG isolation coverage; only a Dependabot-authored pull_request may run without it.",
    );
    process.exit(1);
  }

  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    console.error("GITHUB_OUTPUT is required to retain the critical RAG preflight decision.");
    process.exit(1);
  }
  fs.appendFileSync(output, `run_rag_scope=${decision === "run"}\n`);
  if (decision === "dependabot-exempt") {
    console.log("RAG isolation DB test explicitly exempted: Dependabot pull requests do not receive repository secrets.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
