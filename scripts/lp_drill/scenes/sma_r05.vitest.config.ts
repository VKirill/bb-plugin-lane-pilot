// Runs scenes/sma_r05_probe.test.ts only (the probe needs vitest's module graph: the plugin's rooms import each other in cycles that plain tsx rejects).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/lp_drill/scenes/sma_r05_probe.test.ts"],
    testTimeout: 600_000,
    env: { LANE_PILOT_AGY_BIN: "" },
    setupFiles: ["./tests/setup-jsdom.ts", "./tests/setup-shared-modules.ts"],
    isolate: false,
  },
});
