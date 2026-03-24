import { test, expect } from '@playwright/test';

// Agent API — test psmux session management
// Requires: AGENT_SECRET env var, agent running on port 9876

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:9876';
const AGENT_SECRET = process.env.AGENT_SECRET;

const TEST_PROJECT = 'button'; // known project in D:\projects

function headers() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${AGENT_SECRET}`,
  };
}

test.beforeAll(() => {
  if (!AGENT_SECRET) {
    throw new Error('AGENT_SECRET env var is required. Set it before running tests.');
  }
});

// --- Group A: Independent tests ---

test.describe('Agent health & psmux readiness', () => {
  test('GET /health returns online status', async ({ request }) => {
    const res = await request.get(`${AGENT_URL}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status', 'online');
    expect(body).toHaveProperty('uptime');
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThan(0);
  });

  test('GET /status returns sessions array and metrics', async ({ request }) => {
    const res = await request.get(`${AGENT_URL}/status`, { headers: headers() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status', 'online');
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('projects');
    expect(body).toHaveProperty('tasks');
  });

  test('GET /projects returns project list including test project', async ({ request }) => {
    const res = await request.get(`${AGENT_URL}/projects`, { headers: headers() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects.length).toBeGreaterThan(0);
    expect(body.projects).toContain(TEST_PROJECT);
  });

  test('rejects request without auth', async ({ request }) => {
    const res = await request.get(`${AGENT_URL}/status`);
    expect(res.status()).toBe(401);
  });

  test('rejects invalid project name with path traversal', async ({ request }) => {
    const res = await request.post(`${AGENT_URL}/run`, {
      headers: headers(),
      data: { action: 'proj', name: '../etc' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

// --- Group B: Sequential session lifecycle ---

test.describe.serial('psmux session lifecycle', () => {
  const SESSION_NAME = 'e2e-psmux-test';

  test('proj action creates a psmux session', async ({ request }) => {
    // Use a real project to create a session
    const res = await request.post(`${AGENT_URL}/run`, {
      headers: headers(),
      data: { action: 'proj', name: SESSION_NAME },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe('proj');
  });

  test('session appears in status after creation', async ({ request }) => {
    // Wait for psmux session to be created (proj has a 5s setTimeout)
    await new Promise(r => setTimeout(r, 8000));

    const res = await request.get(`${AGENT_URL}/status`, { headers: headers() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const sessionNames = body.sessions.map((s: { name: string }) => s.name);
    expect(sessionNames).toContain(SESSION_NAME);
  });

  test('protect-session marks session as protected', async ({ request }) => {
    const res = await request.post(`${AGENT_URL}/run`, {
      headers: headers(),
      data: { action: 'protect-session', name: SESSION_NAME },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Verify protection in status
    const statusRes = await request.get(`${AGENT_URL}/status`, { headers: headers() });
    const body = await statusRes.json();
    const session = body.sessions.find((s: { name: string }) => s.name === SESSION_NAME);
    expect(session).toBeDefined();
    expect(session.protected).toBe(true);
  });

  test('unprotect-session removes protection', async ({ request }) => {
    const res = await request.post(`${AGENT_URL}/run`, {
      headers: headers(),
      data: { action: 'unprotect-session', name: SESSION_NAME },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Verify unprotected in status
    const statusRes = await request.get(`${AGENT_URL}/status`, { headers: headers() });
    const body = await statusRes.json();
    const session = body.sessions.find((s: { name: string }) => s.name === SESSION_NAME);
    expect(session).toBeDefined();
    expect(session.protected).toBe(false);
  });

  test('kill-session removes session gracefully', async ({ request }) => {
    const res = await request.post(`${AGENT_URL}/run`, {
      headers: headers(),
      data: { action: 'kill-session', name: SESSION_NAME },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Wait for graceful kill (C-c → /exit → kill takes ~3s)
    await new Promise(r => setTimeout(r, 5000));

    // Verify session is gone
    const statusRes = await request.get(`${AGENT_URL}/status`, { headers: headers() });
    const body = await statusRes.json();
    const sessionNames = body.sessions.map((s: { name: string }) => s.name);
    expect(sessionNames).not.toContain(SESSION_NAME);
  });
});
