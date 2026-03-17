import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, kvDel, KEYS } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Verify secret (supports Vercel Cron header or external cron query param)
  const authHeader = request.headers.get("authorization");
  const querySecret = request.nextUrl.searchParams.get("secret");
  const expected = process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${expected}` && querySecret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cookie = await kvGet<string>(KEYS.routerCookie);
  if (!cookie) {
    console.log("[cron/router-keepalive] No router cookie in KV — skipping");
    return NextResponse.json({ ok: true, action: "skip", reason: "no-cookie" });
  }

  // Resolve router host
  const host = process.env.PC_HOST;
  if (!host) {
    return NextResponse.json({ ok: false, error: "PC_HOST not configured" }, { status: 500 });
  }

  try {
    const { resolve4 } = await import("dns/promises");
    let ip: string;
    try {
      const addrs = await resolve4(host);
      ip = addrs[0];
    } catch {
      ip = host;
    }

    // Send keep-alive request to router main.html (inner_data.html returns empty on some ports)
    // Logged in: len > 1000 (full page). Not logged in: len ≈ 733 (intro redirect).
    const url = `http://${ip}:88/web/main.html`;
    const res = await fetch(url, {
      headers: {
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });

    const text = await res.text();

    // Check if session is still alive
    if (text.length < 1000 || text.includes("intro.html")) {
      // Don't delete cookie — agent may still have valid session on port 80
      console.log(`[cron/router-keepalive] Session not valid via port 88 (len=${text.length}, status=${res.status}, snippet=${text.substring(0, 100)})`);
      return NextResponse.json({ ok: false, action: "session-invalid", detail: `len=${text.length}, status=${res.status}` });
    }

    // Session alive — refresh TTL (86400s = 24h)
    await kvSet(KEYS.routerCookie, cookie, 86400);
    console.log(`[cron/router-keepalive] Session alive (len=${text.length}) — TTL refreshed to 24h`);
    return NextResponse.json({ ok: true, action: "refreshed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/router-keepalive] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
