import { NextResponse } from "next/server";

import { getBuildVersion } from "@/config/deployment";

export const dynamic = "force-dynamic";

type LiveResponse = {
  status: "ok";
  version: string;
};

export function createLiveHandler(getVersion: () => string = getBuildVersion) {
  return function GET(): NextResponse<LiveResponse> {
    return NextResponse.json(
      { status: "ok", version: getVersion() },
      { headers: { "Cache-Control": "no-store" } },
    );
  };
}

export const GET = createLiveHandler();
