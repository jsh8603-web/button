import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, KEYS, type Command } from "@/lib/kv";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, name } = body;

    if (!action) {
      return NextResponse.json({ error: "action required" }, { status: 400 });
    }

    // Append to command queue (instead of overwriting single command)
    const existing = await kvGet<Command[]>(KEYS.command) || [];
    existing.push({ action, name, timestamp: Date.now() });
    await kvSet(KEYS.command, existing, 120);

    return NextResponse.json({ ok: true, action });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
