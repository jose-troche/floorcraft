import { defineConfig, devices } from "@playwright/test";

// Drives the real app against a running `wrangler dev` instance rather than starting
// its own server: the Worker (D1, /api/config, /api/plans) is part of what's under
// test, and Vite's dev server alone can't answer those routes. Start wrangler first
// (`npm run build && npx wrangler dev --local --port 8788`), then run `npm run test:e2e`.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:8788",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
