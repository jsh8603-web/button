import { defineConfig } from '@playwright/test';

const PI_URL = process.env.PI_URL || 'http://192.168.219.125:7777';
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:9876';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  projects: [
    {
      name: 'pi',
      testMatch: /^(?!.*psmux).*\.spec\.ts$/,
      use: { baseURL: PI_URL },
    },
    {
      name: 'agent',
      testMatch: /psmux.*\.spec\.ts$/,
      use: { baseURL: AGENT_URL },
    },
  ],
});
