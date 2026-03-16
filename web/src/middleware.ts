import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth, heartbeat, and cron endpoints
  if (pathname === "/api/auth" || pathname === "/api/heartbeat" || pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  const token = request.cookies.get("token")?.value;

  if (!token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // JWT validation is done in a simple way for Edge Runtime compatibility
  // The token is a base64url-encoded JWT; we verify the structure here
  // Full verification happens in the API routes via the auth lib
  const parts = token.split(".");
  if (parts.length !== 3) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const payload = JSON.parse(atob(parts[1]));
    // Check expiration
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!payload.authorized) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
