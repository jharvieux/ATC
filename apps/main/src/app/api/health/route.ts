import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const vercelCommit = process.env["VERCEL_GIT_COMMIT_SHA"];
  const gitCommit = process.env["GIT_COMMIT_SHA"];

  return NextResponse.json({
    status: "ok",
    service: "main",
    // Vercel populates VERCEL_GIT_COMMIT_SHA at build+runtime; GIT_COMMIT_SHA is
    // never set in prod, so reading it alone always yielded "unknown" (#542).
    commit: vercelCommit !== undefined
      ? vercelCommit.trim() || "unknown"
      : gitCommit?.trim() || "unknown",
    commitSource: vercelCommit !== undefined
      ? "vercel"
      : gitCommit !== undefined
        ? "git"
        : "unknown",
  });
}
