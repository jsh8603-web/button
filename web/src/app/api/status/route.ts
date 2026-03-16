import { NextResponse } from "next/server";
import { kvGet, kvDel, KEYS, type Heartbeat } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await kvGet<Heartbeat>(KEYS.heartbeat);

    if (data && Date.now() - data.timestamp < 90_000) {
      // Clear last power action when PC comes back online
      await kvDel(KEYS.lastPowerAction);
      return NextResponse.json({ status: "online", uptime: data.uptime, sessions: data.sessions || [] });
    }

    const lastAction = await kvGet<string>(KEYS.lastPowerAction);
    return NextResponse.json({ status: "offline", lastAction });
  } catch {
    return NextResponse.json({ status: "offline" });
  }
}
