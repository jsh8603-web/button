import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _client;
}

const TABLE = "agent_kv";

export interface SessionInfo {
  name: string;
  protected: boolean;
}

export interface Heartbeat {
  timestamp: number;
  uptime: number;
  sessions: SessionInfo[];
}

export interface Command {
  action: string;
  name?: string;
  timestamp: number;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const { data } = await getClient()
    .from(TABLE)
    .select("value")
    .eq("key", key)
    .single();
  return (data?.value as T) ?? null;
}

export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const expires_at = ttlSeconds
    ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
    : null;
  await getClient().from(TABLE).upsert({
    key,
    value,
    expires_at,
    updated_at: new Date().toISOString(),
  });
}

export async function kvDel(key: string): Promise<void> {
  await getClient().from(TABLE).delete().eq("key", key);
}

export const KEYS = {
  heartbeat: "btn:heartbeat",
  projects: "btn:projects",
  command: "btn:command",
  protected: "btn:protected",
  lastPowerAction: "btn:last-power-action",
  routerCookie: "btn:router-cookie",
} as const;
