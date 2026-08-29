import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worker-side unit tests only. The Playwright suite (e2e/) runs separately via
    // `npm run test:e2e` and must not be collected here.
    include: ["test/**/*.test.ts"],
    // One file at a time. test/mcp/budget.test.ts samples on the wall clock (see its
    // header for why), so a sibling test file competing for the same core lands in its
    // tail. Normalising by CPU fixes the mean but cannot rescue an individual preempted
    // sample, and the tail is what MCP-3 gates on. The suite is small; serial costs a
    // second.
    fileParallelism: false,
  },
});
