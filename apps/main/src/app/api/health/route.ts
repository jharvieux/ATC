import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "main",
    commit: process.env["GIT_COMMIT_SHA"] ?? "unknown",
  });
}
