import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    testTimeout: 15000,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/rooms/**/tests/**/*.test.ts", "src/rooms/**/tests/**/*.test.tsx", "packages/*/tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-jsdom.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
