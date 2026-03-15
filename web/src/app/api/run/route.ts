import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const host = process.env.PC_HOST;
  const port = process.env.PC_PORT || "9876";
  const agentPin = process.env.AGENT_PIN;

  if (!host) {
    return NextResponse.json({ error: "PC_HOST not configured" }, { status: 500 });
  }

  try {
    const body = await request.json();
    const { action, name } = body;

    if (!action) {
      return NextResponse.json({ error: "action required" }, { status: 400 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`http://${host}:${port}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(agentPin ? { "x-pin-hash": agentPin } : {}),
      },
      body: JSON.stringify({ action, name }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "PC unreachable" }, { status: 503 });
  }
}
