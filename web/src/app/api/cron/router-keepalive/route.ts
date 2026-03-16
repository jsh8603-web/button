import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, kvDel, KEYS } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Verify Vercel Cron secret (prevents external abuse)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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

    // Send keep-alive request to router (same as agent's keepAlive check)
    const url = `http://${ip}:88/web/inner_data.html?func=get_basic_info`;
    const res = await fetch(url, {
      headers: {
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });

    const text = await res.text();

    // Check if session is still alive
    if (text.includes("captcha") || text.includes("http_passwd") || text.includes("intro")) {
      // Session expired — remove stale cookie from KV
      await kvDel(KEYS.routerCookie);
      console.log("[cron/router-keepalive] Session expired — cookie removed from KV");
      return NextResponse.json({ ok: true, action: "expired", detail: "session-expired, cookie removed" });
    }

    // Session alive — refresh TTL (86400s = 24h)
    await kvSet(KEYS.routerCookie, cookie, 86400);
    console.log("[cron/router-keepalive] Session alive — TTL refreshed to 24h");
    return NextResponse.json({ ok: true, action: "refreshed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/router-keepalive] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
