import { NextResponse } from "next/server";
import { kvGet, kvDel, KEYS, type Heartbeat } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [data, captchaStatus, captchaManual] = await Promise.all([
      kvGet<Heartbeat>(KEYS.heartbeat),
      kvGet<string>(KEYS.captchaStatus),
      kvGet<{ image: string; params: Record<string, string> }>(KEYS.captchaManual),
    ]);

    if (data && Date.now() - data.timestamp < 45_000) {
      // Clear last power action in background (don't block response)
      kvDel(KEYS.lastPowerAction).catch(() => {});
      return NextResponse.json({
        status: "online",
        uptime: data.uptime,
        sessions: data.sessions || [],
        ...(captchaStatus ? { captchaStatus } : {}),
        ...(captchaManual ? { captchaManual } : {}),
      });
    }

    const lastAction = await kvGet<string>(KEYS.lastPowerAction);
    return NextResponse.json({
      status: "offline",
      lastAction,
      ...(captchaStatus ? { captchaStatus } : {}),
      ...(captchaManual ? { captchaManual } : {}),
    });
  } catch {
    return NextResponse.json({ status: "offline" });
  }
}
