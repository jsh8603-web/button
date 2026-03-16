import { NextRequest, NextResponse } from "next/server";
import { verifyPin, createToken } from "@/lib/auth";

const failureMap = new Map<string, { count: number; lockedUntil: number }>();

function getClientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isRateLimited(ip: string): boolean {
  const entry = failureMap.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  if (entry.lockedUntil > 0 && entry.lockedUntil <= Date.now()) {
    failureMap.delete(ip);
    return false;
  }
  return false;
}

function recordFailure(ip: string): void {
  const entry = failureMap.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.lockedUntil = Date.now() + 60_000;
    entry.count = 0;
  }
  failureMap.set(ip, entry);
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const { pin } = body;

    if (!pin || typeof pin !== "string") {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }

    const valid = await verifyPin(pin);

    if (!valid) {
      recordFailure(ip);
      return NextResponse.json({ error: "invalid" }, { status: 401 });
    }

    // Clear failures on success
    failureMap.delete(ip);

    const token = createToken();
    const response = NextResponse.json({ ok: true });
    response.cookies.set("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    });

    return response;
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
}
