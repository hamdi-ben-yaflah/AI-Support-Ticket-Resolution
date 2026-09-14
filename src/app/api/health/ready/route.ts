import { NextResponse } from "next/server";

import { checkDatabaseReadiness } from "@/db/readiness";

export const dynamic = "force-dynamic";

type ReadyResponse = {
  status: "ok" | "unavailable";
};

export function createReadyHandler(check: () => Promise<void> = checkDatabaseReadiness) {
  return async function GET(): Promise<NextResponse<ReadyResponse>> {
    try {
      await check();
      return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json(
        { status: "unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}

export const GET = createReadyHandler();
