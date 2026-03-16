import { NextResponse } from "next/server";
import { kvGet, kvDel, KEYS, type Heartbeat } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [data, captchaStatus] = await Promise.all([
      kvGet<Heartbeat>(KEYS.heartbeat),
      kvGet<string>(KEYS.captchaStatus),
    ]);

    if (data && Date.now() - data.timestamp < 45_000) {
      // Clear last power action in background (don't block response)
      kvDel(KEYS.lastPowerAction).catch(() => {});
      return NextResponse.json({
        status: "online",
        uptime: data.uptime,
        sessions: data.sessions || [],
        ...(captchaStatus ? { captchaStatus } : {}),
      });
    }

    const lastAction = await kvGet<string>(KEYS.lastPowerAction);
    return NextResponse.json({
      status: "offline",
      lastAction,
      ...(captchaStatus ? { captchaStatus } : {}),
    });
  } catch {
    return NextResponse.json({ status: "offline" });
  }
}
