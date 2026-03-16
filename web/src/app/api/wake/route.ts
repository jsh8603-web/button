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

    // Send 3 times for reliability (ARP cache / NIC wake timing)
    const sendOnce = () =>
      new Promise<void>((resolve, reject) => {
        client.send(packet, 0, packet.length, port, targetIp, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    await sendOnce();
    await delay(250);
    await sendOnce();
    await delay(250);
    await sendOnce();
    client.close();

    log.step = "sent";
    log.packetsSent = 3;
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
