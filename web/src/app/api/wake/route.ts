import { NextResponse } from "next/server";
import dns from "dns/promises";

function createMagicPacket(mac: string): Buffer {
  const macBytes = mac
    .split(":")
    .map((hex) => parseInt(hex, 16));

  const packet = Buffer.alloc(102);

  // 6 bytes of 0xFF
  for (let i = 0; i < 6; i++) {
    packet[i] = 0xff;
  }

  // 16 repetitions of MAC address
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      packet[6 + i * 6 + j] = macBytes[j];
    }
  }

  return packet;
}

// Send WOL via router's built-in Wake On LAN (LAN broadcast — works for Sleep/Hibernate)
async function sendRouterWol(host: string, mac: string): Promise<{ ok: boolean; detail: string }> {
  const password = process.env.ROUTER_PASSWORD;
  if (!password) return { ok: false, detail: "ROUTER_PASSWORD not configured" };

  const baseUrl = `http://${host}:88`;

  try {
    // Call router WOL API directly (test if auth is needed)
    const wolUrl = `${baseUrl}/web/inner-data.html?func=wake_on_lan(%221%22,%22${mac}%22)`;

    const res = await fetch(wolUrl, {
      signal: AbortSignal.timeout(10000),
    });

    const text = await res.text();

    if (res.ok && !text.includes("login")) {
      return { ok: true, detail: `direct: status=${res.status}` };
    }

    // If direct call fails or requires login, try with Basic Auth
    const auth = Buffer.from(`admin:${password}`).toString("base64");
    const authRes = await fetch(wolUrl, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10000),
    });

    const authText = await authRes.text();
    return {
      ok: authRes.ok,
      detail: `basic-auth: status=${authRes.status}, body=${authText.substring(0, 200)}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function POST() {
  const log: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    action: "wake",
    runtime: process.env.VERCEL ? "vercel" : "local",
  };

  try {
    const mac = process.env.PC_MAC;
    const host = process.env.PC_HOST;
    const port = parseInt(process.env.WOL_PORT || "9", 10);

    if (!mac || !host) {
      log.step = "config";
      log.error = "PC_MAC or PC_HOST not configured";
      console.error("[wake]", JSON.stringify(log));
      return NextResponse.json(
        { error: log.error, log },
        { status: 500 }
      );
    }

    log.target = { host, port, mac };

    const packet = createMagicPacket(mac);
    log.step = "packet_created";

    // Resolve hostname to IP for UDP
    let targetIp: string;
    try {
      const addresses = await dns.resolve4(host);
      targetIp = addresses[0];
      log.resolvedIp = targetIp;
    } catch (dnsErr) {
      targetIp = host;
      log.resolvedIp = host;
      log.dnsError = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
    }

    log.step = "importing_dgram";

    // Dynamic import for dgram (Node.js module — may fail on serverless)
    const dgram = await import("dgram");
    log.step = "dgram_loaded";

    const client = dgram.createSocket("udp4");
    log.step = "socket_created";

    // Send UDP magic packet 3 times (works for Shutdown WOL)
    const sendOnce = () =>
      new Promise<void>((resolve, reject) => {
        client.send(packet, 0, packet.length, port, targetIp, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Send UDP and router WOL in parallel
    const [udpResult, routerResult] = await Promise.allSettled([
      (async () => {
        await sendOnce();
        await delay(250);
        await sendOnce();
        await delay(250);
        await sendOnce();
        client.close();
      })(),
      sendRouterWol(targetIp, mac),
    ]);

    log.step = "sent";
    log.udp = udpResult.status === "fulfilled" ? "success" : (udpResult as PromiseRejectedResult).reason?.message;
    log.routerWol = routerResult.status === "fulfilled" ? (routerResult as PromiseFulfilledResult<{ ok: boolean; detail: string }>).value : (routerResult as PromiseRejectedResult).reason?.message;
    log.result = "success";
    console.log("[wake]", JSON.stringify(log));
    return NextResponse.json({ ok: true, message: "Magic packet sent", log });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log.result = "error";
    log.error = message;
    log.errorName = error instanceof Error ? error.constructor.name : typeof error;
    log.stack = error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" | ") : undefined;
    console.error("[wake]", JSON.stringify(log));
    return NextResponse.json(
      { error: "Failed to send magic packet", detail: message, log },
      { status: 500 }
    );
  }
}
