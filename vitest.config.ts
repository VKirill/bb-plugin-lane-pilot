import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import LongestFirstSequencer from "./tests/sequencer";

// Test files that call vi.mock/vi.doMock: a mock replaces a module for every file that shares its module cache, so they run isolated.
const mocking = [
  // Not mocks, but module-level state that must start empty: the drain, outbound subscriptions and skill-pick slots.
  "tests/deploy-drain.test.ts",
  "tests/errand-episode-sweep.test.ts",
  "tests/world-version-invalidate.test.ts",
  "tests/stages/critic-answer-retry.test.ts",
  "tests/install-metadata.test.ts",
  "tests/install-cas.test.ts",
  "tests/native-project-isolation.test.ts",
  "tests/writer-follow-up-budget.test.ts",
  "tests/spawn-service-tier.test.ts",
  "tests/spawn-models.test.ts",
  "tests/remote-git-detect.test.ts",
  "tests/qa-login.test.ts",
  "tests/stage-helper-live-settings.test.ts",
  "tests/schedule/agent.test.ts",
  "tests/schedule/executors.test.ts",
  "tests/schedule/workflow-outcome.test.ts",
  "tests/server/helper-probe.test.ts",
  "tests/verification/replay-check-handler.test.ts",
  "tests/stage-return/return.test.ts",
  // Replaces spawnAsync of @lane-pilot/kit (the worker probe's sudo): shared, it would answer for every other file's commands.
  "tests/sma/parity-d10-rest-2.test.ts",
  // Replaces the embedding call and the reranker, to count that the prompt recall makes neither.
  "tests/sma/parity-g2-hooks-2.test.ts",
  // Replaces the QA thread: shared, the mock took effect only when no earlier file had loaded the module (three reds in a full run, green alone).
  "tests/sma/parity-g7-rest-b.test.ts",
  // The same hazard, found by tests/architecture/mocking-isolated.test.ts: the writer's diff rules, waitThreadIdle, and the platform and runs servers.
  "tests/sma/parity-g1-hooks-1.test.ts",
  "tests/sma/parity-c1-have.test.ts",
  "tests/workflow/agent-send-dedup.test.ts",
  // Four-proofs tests of the SMA map regions that replace a module (one line per file; prefer a fake passed in over vi.mock).
  "tests/sma/four-proofs-r13-a.test.ts",
  "tests/sma/four-proofs-r03-a2.test.ts",
];
const nodeTests = ["tests/**/*.test.ts", "src/rooms/**/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"];
// Page tests that fail when the document (an open picker window, a registered settings backend) is shared with the files before them.
const uiAlone = ["tests/schedule-detail-ui.test.tsx", "tests/harness-ui.test.tsx", "tests/composer-activation.test.tsx", "tests/workflow-models-ui.test.tsx", "tests/ui-settings-integration/part*.test.tsx", "tests/improvement/improvement-ui.test.tsx", "tests/role-models-ui.test.tsx", "tests/agent-access-ui.test.tsx"];
const uiTests = ["tests/**/*.test.tsx", "src/rooms/**/tests/**/*.test.tsx"];

// Every workspace package resolves to THIS tree. In a worktree node_modules is the main checkout's, so an import by package name
// would run the main checkout's code: a change or a mutation of packages/* made in a worktree went unseen by its own tests (2026-11-14).
const packagesDir = fileURLToPath(new URL("./packages/", import.meta.url));
const workspaceAliases = readdirSync(packagesDir).flatMap((dir) => {
  let manifest: { name?: string; exports?: Record<string, unknown> };
  try { manifest = JSON.parse(readFileSync(`${packagesDir}${dir}/package.json`, "utf8")); } catch { return []; }
  return Object.entries(manifest.exports ?? {}).flatMap(([sub, target]) => typeof target !== "string" || !manifest.name ? [] : [{
    find: new RegExp(`^${`${manifest.name}${sub.slice(1)}`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
    replacement: `${packagesDir}${dir}/${target.replace(/^\.\//, "")}`,
  }]);
});

export default defineConfig({
  test: {
    // 30 s: a deploy shares the machine with the night's writers (load 20 on 16 cores, 2026-11-11), and tests that take 2-5 s alone
    // crossed 15 s there three times in two days. A real hang still fails.
    testTimeout: 30000,
    // One queue for all projects, longest file first (tests/sequencer.ts).
    ...(process.env.LP_DEFAULT_ORDER ? {} : { sequence: { sequencer: LongestFirstSequencer } }),
    setupFiles: ["./tests/setup-jsdom.ts"],
    // No test runs the real Antigravity CLI (the memory judge's agy/ route): an empty LANE_PILOT_AGY_BIN turns it off.
    env: { LANE_PILOT_AGY_BIN: "" },
    // One temp directory per run (TMPDIR for every worker of every project), removed after it: see tests/global-setup.ts.
    globalSetup: ["./tests/global-setup.ts"],
    projects: [
      // Node tests share one module graph per worker (no per-file re-import of the whole plugin).
      { extends: true, test: { name: "node", include: nodeTests, exclude: mocking, isolate: false, setupFiles: ["./tests/setup-jsdom.ts", "./tests/setup-shared-modules.ts"] } },
      { extends: true, test: { name: "node-isolated", include: mocking } },
      { extends: true, test: { name: "ui", include: uiTests, exclude: uiAlone, isolate: false } },
      { extends: true, test: { name: "ui-isolated", include: uiAlone } },
    ],
  },
  resolve: {
    alias: [{ find: "@", replacement: fileURLToPath(new URL(".", import.meta.url)) }, ...workspaceAliases],
  },
});
