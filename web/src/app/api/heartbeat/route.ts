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
    const { uptime, projects, sessions, routerCookie, routerCookieTTL, captchaStatus, routerLoggedIn } = body;

    // Store heartbeat (45s TTL)
    await kvSet(KEYS.heartbeat, { timestamp: Date.now(), uptime, sessions: sessions || [], routerLoggedIn: !!routerLoggedIn }, 45);

    // Store router session cookie (default 86400s/24h — Cron refreshes every 30min, agent heartbeat every 30s)
    if (routerCookie) {
      const ttl = typeof routerCookieTTL === 'number' && routerCookieTTL > 0 ? routerCookieTTL : 86400;
      await kvSet(KEYS.routerCookie, routerCookie, ttl);
    }

    // Store project list (300s TTL)
    if (projects) {
      await kvSet(KEYS.projects, { projects }, 300);
    }

    // Store CAPTCHA progress status (120s TTL, empty string clears)
    if (typeof captchaStatus === 'string') {
      if (captchaStatus) {
        await kvSet(KEYS.captchaStatus, captchaStatus, 120);
      } else {
        await kvDel(KEYS.captchaStatus);
      }
    }

    // Store manual CAPTCHA image+params (for user to solve)
    if (body.captchaManual) {
      await kvSet(KEYS.captchaManual, body.captchaManual, 300);
    }
    if (body.captchaManualClear) {
      await kvDel(KEYS.captchaManual);
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
