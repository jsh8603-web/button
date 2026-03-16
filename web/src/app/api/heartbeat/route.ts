import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, kvDel, KEYS, type Command } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!secret || secret !== process.env.AGENT_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { uptime, projects, sessions } = body;

    // Store heartbeat (90s TTL)
    await kvSet(KEYS.heartbeat, { timestamp: Date.now(), uptime, sessions: sessions || [] }, 90);

    // Store project list (300s TTL)
    if (projects) {
      await kvSet(KEYS.projects, { projects }, 300);
    }

    // Check for pending command and return it
    const command = await kvGet<Command>(KEYS.command);
    if (command) {
      await kvDel(KEYS.command);
      return NextResponse.json({ ok: true, command });
    }

    return NextResponse.json({ ok: true, command: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
