import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The deployed version, so open pages can tell when a newer one is live. */
export function GET() {
  return NextResponse.json({ v: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID ?? "dev" }, { headers: { "cache-control": "no-store" } });
}
