CREATE TABLE IF NOT EXISTS agent_kv (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE agent_kv ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_only" ON agent_kv
  FOR ALL USING (auth.role() = 'service_role');
