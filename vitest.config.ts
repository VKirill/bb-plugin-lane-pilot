import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Test files that call vi.mock/vi.doMock: a mock replaces a module for every file that shares its module cache, so they run isolated.
const mocking = [
  "tests/jev-plan.test.ts",
  "tests/spawn-service-tier.test.ts",
  "tests/remote-git-detect.test.ts",
  "tests/qa-login.test.ts",
  "tests/stage-helper-live-settings.test.ts",
  "tests/schedule/executors.test.ts",
  "tests/schedule/workflow-outcome.test.ts",
  "tests/server/helper-probe.test.ts",
  "tests/verification/replay-check-handler.test.ts",
];
const nodeTests = ["tests/**/*.test.ts", "src/rooms/**/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"];
// Page tests that fail when the document (an open picker window, a registered settings backend) is shared with the files before them.
const uiAlone = ["tests/schedule-detail-ui.test.tsx", "tests/composer-activation.test.tsx", "tests/workflow-models-ui.test.tsx", "tests/ui-settings-integration/part*.test.tsx"];
const uiTests = ["tests/**/*.test.tsx", "src/rooms/**/tests/**/*.test.tsx"];

export default defineConfig({
  test: {
    testTimeout: 15000,
    setupFiles: ["./tests/setup-jsdom.ts"],
    projects: [
      // Node tests share one module graph per worker (no per-file re-import of the whole plugin).
      { extends: true, test: { name: "node", include: nodeTests, exclude: mocking, isolate: false } },
      { extends: true, test: { name: "node-isolated", include: mocking } },
      { extends: true, test: { name: "ui", include: uiTests, exclude: uiAlone, isolate: false } },
      { extends: true, test: { name: "ui-isolated", include: uiAlone } },
    ],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
