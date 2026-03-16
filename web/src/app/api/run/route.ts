import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, KEYS, type Command } from "@/lib/kv";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, name } = body;

    if (!action) {
      return NextResponse.json({ error: "action required" }, { status: 400 });
    }

    // Session protection: store as state (not queued) to avoid race conditions
    if (action === "protect-session" && name) {
      const list: string[] = await kvGet<string[]>(KEYS.protected) || [];
      if (!list.includes(name)) list.push(name);
      await kvSet(KEYS.protected, list);
      return NextResponse.json({ ok: true, action });
    }

    if (action === "unprotect-session" && name) {
      const list: string[] = await kvGet<string[]>(KEYS.protected) || [];
      await kvSet(KEYS.protected, list.filter(s => s !== name));
      return NextResponse.json({ ok: true, action });
    }

    // Track power actions for offline status display
    const powerActions = ["sleep", "hibernate", "display_off"];
    if (powerActions.includes(action)) {
      await kvSet(KEYS.lastPowerAction, action);
    }

    // All other actions: append to command queue
    const existing = await kvGet<Command[]>(KEYS.command) || [];
    existing.push({ action, name, timestamp: Date.now() });
    await kvSet(KEYS.command, existing, 120);

    return NextResponse.json({ ok: true, action });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
