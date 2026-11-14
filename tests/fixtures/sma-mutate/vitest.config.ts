import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs only the mutation runner's fixtures (*.fixture.ts): the main config never picks them up, nor does
// scripts/sma-contracts.mjs (it reads *.test.ts titles).
export default defineConfig({
  test: { root: fileURLToPath(new URL("../../..", import.meta.url)), include: ["tests/fixtures/sma-mutate/*.fixture.ts"], testTimeout: 20000 },
});
