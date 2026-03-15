import { NextResponse } from "next/server";
import { kvGet, KEYS, type Heartbeat } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await kvGet<Heartbeat>(KEYS.heartbeat);

    if (data && Date.now() - data.timestamp < 90_000) {
      return NextResponse.json({ status: "online", uptime: data.uptime });
    }

    return NextResponse.json({ status: "offline" });
  } catch {
    return NextResponse.json({ status: "offline" });
  }
}
