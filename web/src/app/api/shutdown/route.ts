import { NextResponse } from "next/server";
import { kvSet, KEYS } from "@/lib/kv";

export async function POST() {
  try {
    await kvSet(KEYS.lastPowerAction, "shutdown");
    await kvSet(KEYS.command, [{
      action: "shutdown",
      timestamp: Date.now(),
    }], 120);

    return NextResponse.json({ ok: true, message: "Shutdown command queued" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
