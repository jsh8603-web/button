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
    const { uptime, projects, sessions, routerCookie } = body;

    // Store heartbeat (45s TTL)
    await kvSet(KEYS.heartbeat, { timestamp: Date.now(), uptime, sessions: sessions || [] }, 45);

    // Store router session cookie if provided (3600s TTL)
    if (routerCookie) {
      await kvSet(KEYS.routerCookie, routerCookie, 3600);
    }

    // Store project list (300s TTL)
    if (projects) {
      await kvSet(KEYS.projects, { projects }, 300);
    }

    // Include KV-stored protection state so agent can sync
    const protectedSessions = await kvGet<string[]>(KEYS.protected) || [];

    // Check for pending commands and return them (queue)
    const commands = await kvGet<Command[]>(KEYS.command);
    if (commands && commands.length > 0) {
      await kvDel(KEYS.command);
      return NextResponse.json({ ok: true, commands, protectedSessions });
    }

    return NextResponse.json({ ok: true, commands: null, protectedSessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
