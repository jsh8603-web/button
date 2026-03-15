import { NextResponse } from "next/server";
import { kvGet, KEYS } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await kvGet<{ projects: string[] }>(KEYS.projects);
    return NextResponse.json({ projects: data?.projects || [] });
  } catch {
    return NextResponse.json({ projects: [] });
  }
}
