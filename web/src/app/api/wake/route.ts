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
  try {
    const mac = process.env.PC_MAC;
    const host = process.env.PC_HOST;
    const port = parseInt(process.env.WOL_PORT || "9", 10);

    if (!mac || !host) {
      return NextResponse.json(
        { error: "PC_MAC or PC_HOST not configured" },
        { status: 500 }
      );
    }

    const packet = createMagicPacket(mac);

    // Resolve hostname to IP for UDP
    let targetIp: string;
    try {
      const addresses = await dns.resolve4(host);
      targetIp = addresses[0];
    } catch {
      // If resolution fails, try using the host directly
      targetIp = host;
    }

    // Dynamic import for dgram (Node.js module)
    const dgram = await import("dgram");
    const client = dgram.createSocket("udp4");

    await new Promise<void>((resolve, reject) => {
      client.send(packet, 0, packet.length, port, targetIp, (err) => {
        client.close();
        if (err) reject(err);
        else resolve();
      });
    });

    return NextResponse.json({ ok: true, message: "Magic packet sent" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to send magic packet", detail: message },
      { status: 500 }
    );
  }
}
