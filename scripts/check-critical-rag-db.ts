import fs from "node:fs";
import { pathToFileURL } from "node:url";

interface CriticalRagDbContext {
  dbUrl: string | undefined;
  eventName: string | undefined;
  pullRequestAuthor: string | undefined;
}

export const MAIN_RLS_CREDENTIALS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
] as const;

type MainRlsCredential = (typeof MAIN_RLS_CREDENTIALS)[number];

interface CriticalMainRlsContext {
  credentials: Readonly<Record<MainRlsCredential, string | undefined>>;
  eventName: string | undefined;
  pullRequestAuthor: string | undefined;
}

export type CriticalDbDecision = "run" | "dependabot-exempt" | "fail";

function missingSecretsAreDependabotExempt(eventName: string | undefined, pullRequestAuthor: string | undefined): boolean {
  return eventName === "pull_request" && pullRequestAuthor === "dependabot[bot]";
}

export function criticalRagDbDecision({
  dbUrl,
  eventName,
  pullRequestAuthor,
}: CriticalRagDbContext): CriticalDbDecision {
  if (dbUrl?.trim()) return "run";
  if (missingSecretsAreDependabotExempt(eventName, pullRequestAuthor)) {
    return "dependabot-exempt";
  }
  return "fail";
}

export function criticalMainRlsDecision({
  credentials,
  eventName,
  pullRequestAuthor,
}: CriticalMainRlsContext): CriticalDbDecision {
  if (MAIN_RLS_CREDENTIALS.every((name) => credentials[name]?.trim())) return "run";
  if (missingSecretsAreDependabotExempt(eventName, pullRequestAuthor)) return "dependabot-exempt";
  return "fail";
}

function main(): void {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const pullRequestAuthor = process.env.ISOLATION_PR_AUTHOR;
  const mainDecision = criticalMainRlsDecision({
    credentials: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_DB_URL: process.env.SUPABASE_DB_URL,
    },
    eventName,
    pullRequestAuthor,
  });
  const ragDecision = criticalRagDbDecision({
    dbUrl: process.env.SUPABASE_RAG_DB_URL,
    eventName,
    pullRequestAuthor,
  });
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    console.error("GITHUB_OUTPUT is required to retain the critical isolation preflight decision.");
    process.exit(1);
  }
  fs.appendFileSync(output, `run_main_rls=${mainDecision === "run"}\n`);
  fs.appendFileSync(output, `run_rag_scope=${ragDecision === "run"}\n`);

  let failed = false;
  if (mainDecision === "fail") {
    const missing = MAIN_RLS_CREDENTIALS.filter((name) => !process.env[name]?.trim());
    console.error(
      `Critical main RLS coverage requires all Supabase credentials; missing: ${missing.join(", ")}. Only a Dependabot-authored pull_request may run without them.`,
    );
    failed = true;
  }
  if (ragDecision === "fail") {
    console.error(
      "SUPABASE_RAG_DB_URL is required for critical RAG isolation coverage; only a Dependabot-authored pull_request may run without it.",
    );
    failed = true;
  }
  if (failed) process.exit(1);
  if (mainDecision === "dependabot-exempt" || ragDecision === "dependabot-exempt") {
    console.log("Critical isolation DB tests with missing credentials are explicitly exempted for Dependabot pull requests.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
