import { defineConfig } from "vite";

// Builds only the client (chat UI + canvas + plan store). The Worker script in
// src/worker/index.ts is bundled separately by Wrangler, which serves this
// output via the ASSETS binding (specs.md §8.1) and never runs Vite itself.
export default defineConfig({
  root: "src/client",
  publicDir: "public",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
