import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const host = process.env.PC_HOST;
  const port = process.env.PC_PORT || "9876";

  if (!host) {
    return NextResponse.json({ status: "offline" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({ status: "online", uptime: data.uptime });
    }

    return NextResponse.json({ status: "offline" });
  } catch {
    return NextResponse.json({ status: "offline" });
  }
}
