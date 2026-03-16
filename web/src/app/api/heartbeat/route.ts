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
    const { uptime, projects, sessions, routerCookie, routerCookieTTL } = body;

    // Store heartbeat (45s TTL)
    await kvSet(KEYS.heartbeat, { timestamp: Date.now(), uptime, sessions: sessions || [] }, 45);

    // Store router session cookie (default 3600s, pre-sleep sends 86400s for 24h persistence)
    if (routerCookie) {
      const ttl = typeof routerCookieTTL === 'number' && routerCookieTTL > 0 ? routerCookieTTL : 3600;
      await kvSet(KEYS.routerCookie, routerCookie, ttl);
    }

    // Store project list (300s TTL)
    if (projects) {
      await kvSet(KEYS.projects, { projects }, 300);
    }

    // Include KV-stored protection state so agent can sync
    const protectedSessions = await kvGet<string[]>(KEYS.protected) || [];

    // Return stored router cookie so agent can restore session after restart
    const storedRouterCookie = body.needRouterCookie ? await kvGet<string>(KEYS.routerCookie) : undefined;

    // Check for pending commands and return them (queue)
    const commands = await kvGet<Command[]>(KEYS.command);
    if (commands && commands.length > 0) {
      await kvDel(KEYS.command);
      return NextResponse.json({ ok: true, commands, protectedSessions, storedRouterCookie });
    }

    return NextResponse.json({ ok: true, commands: null, protectedSessions, storedRouterCookie });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
