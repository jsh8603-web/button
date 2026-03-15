import { NextRequest, NextResponse } from "next/server";
import { kvSet, KEYS } from "@/lib/kv";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, name } = body;

    if (!action) {
      return NextResponse.json({ error: "action required" }, { status: 400 });
    }

    await kvSet(KEYS.command, {
      action,
      name,
      timestamp: Date.now(),
    }, 120);

    return NextResponse.json({ ok: true, action });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
