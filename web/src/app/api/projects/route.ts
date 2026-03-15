import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const host = process.env.PC_HOST;
  const port = process.env.PC_PORT || "9876";
  const agentPin = process.env.AGENT_PIN;

  if (!host) {
    return NextResponse.json({ projects: [] });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`http://${host}:${port}/projects`, {
      headers: {
        ...(agentPin ? { "x-pin-hash": agentPin } : {}),
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ projects: [] });
  }
}
