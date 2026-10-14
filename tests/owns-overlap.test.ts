import { expect, it } from "vitest";
import { ownsPathsOverlap } from "@lane-pilot/kit";

it("lets disjoint tasks run side by side and holds back any that may touch one file", () => {
  expect(ownsPathsOverlap(["apps/bot/**"], ["apps/marketing/**"])).toBe(false);
  expect(ownsPathsOverlap(["apps/bot/src/a.ts"], ["apps/bot/src/b.ts"])).toBe(false);
  expect(ownsPathsOverlap(["apps/bot/**"], ["apps/bot/src/a.ts"])).toBe(true);
  expect(ownsPathsOverlap(["apps/bot/"], ["apps/bot/src/handlers/__tests__/x.test.ts"])).toBe(true);
  expect(ownsPathsOverlap(["packages/contracts/src/*.ts"], ["packages/contracts/src/x.ts"])).toBe(true);
  expect(ownsPathsOverlap(["*.md"], ["apps/bot/README.md"])).toBe(true);
  expect(ownsPathsOverlap(["apps/bot-thin/**"], ["apps/bot/**"])).toBe(false);
});

it("matches wildcards inside names and double stars inside segments (SelfyStudio patterns)", async () => {
  const { matchOwnsPath: m, fileAllowedByOwns } = await import("@lane-pilot/kit");
  expect(m("packages/db/prisma/migrations/20261002_greeting_cards_core/migration.sql", "packages/db/prisma/migrations/*_greeting_cards_core/**")).toBe(true);
  expect(m("packages/db/prisma/migrations/20261002_other/migration.sql", "packages/db/prisma/migrations/*_greeting_cards_core/**")).toBe(false);
  expect(m("apps/api/src/routes/greeting-cards.ts", "apps/api/src/**greeting-card*")).toBe(true);
  expect(m("apps/api/src/deep/x/greeting-card-render.ts", "apps/api/src/**greeting-card*")).toBe(true);
  expect(m("apps/api/src/routes/other.ts", "apps/api/src/**greeting-card*")).toBe(false);
  expect(m("packages/contracts/.vite/vitest/results.json", "packages/*/.vite/**")).toBe(true);
  expect(m("packages/a/b/.vite/x", "packages/*/.vite/**")).toBe(false);
  expect(m("src/a.ts", "src/*.ts")).toBe(true);
  expect(m("src/sub/a.ts", "src/*.ts")).toBe(false);
  expect(m("a/b", "a/**/b")).toBe(true);
  expect(m("apps/bot/x.ts", "apps/bot/")).toBe(true);
  expect(m("apps/bot", "apps/bot/**")).toBe(true);
  expect(fileAllowedByOwns("docs/a.md", ["docs"])).toBe(true);
});

it("uses the same matcher for the run's ownership check", async () => {
  const { findUnownedChanges } = await import("../src/rooms/verification/ownership");
  const task = { project_cwd: "/p", owns_paths: ["apps/api/src/**greeting-card*", "packages/db/prisma/migrations/*_greeting_cards_core/**"], never_touch: [], verification: [] } as never;
  expect(findUnownedChanges(["apps/api/src/routes/greeting-cards.ts", "packages/db/prisma/migrations/20261002_greeting_cards_core/migration.sql"], task)).toEqual([]);
  expect(findUnownedChanges(["apps/api/src/routes/other.ts"], task)).toEqual(["apps/api/src/routes/other.ts"]);
});

it("gives a wildcard pattern that names a folder what is in that folder, as a plain path and the overlap check do", async () => {
  const { matchOwnsPath: m, ownsPathsOverlap: overlap } = await import("@lane-pilot/kit");
  const { classifyWriterOutput } = await import("../src/rooms/tasks/validate-output");
  const { findUnownedChanges } = await import("../src/rooms/verification/ownership");
  // SelfyStudio drop-fotosessii-theme-v1 (2026-10-13): «cocoon-write*» was meant for the executor's test folder; the
  // writer's needed edit there was rejected, and the retry put back a test that still expects the removed scenario.
  const cocoon = "apps/scenario-runner/src/__tests__/executors/cocoon-write*";
  const cocoonTest = "apps/scenario-runner/src/__tests__/executors/cocoon-write/cocoon-write-executor.test.ts";
  expect(m(cocoonTest, cocoon)).toBe(true);
  expect(m("apps/scenario-runner/src/__tests__/executors/cocoon-write.test.ts", cocoon)).toBe(true);
  expect(m("apps/scenario-runner/src/__tests__/executors/cocoon-read/x.test.ts", cocoon)).toBe(false);
  expect(overlap([cocoon], [cocoonTest])).toBe(true);
  // SelfyStudio api-tests-order-pollution (2026-10-12): a folder with a trailing slash and a double star.
  expect(m("apps/api/src/routes/v1/__tests__/referral.test.ts", "apps/api/src/**/__tests__/")).toBe(true);
  expect(m("apps/api/src/lib/__tests__/token-revocation.test.ts", "apps/api/src/**/__tests__/")).toBe(true);
  expect(m("apps/api/src/lib/token-revocation.ts", "apps/api/src/**/__tests__/")).toBe(false);
  // SelfyStudio gc-s2a-persistence (2026-10-02): «**greeting-card*» and the folder greeting-card/.
  expect(m("packages/infrastructure/persistence-prisma/src/greeting-card/index.ts", "packages/infrastructure/persistence-prisma/src/**greeting-card*")).toBe(true);
  // A wildcard on the file name still does not reach into folders that do not match it.
  expect(m("src/sub/a.ts", "src/*.ts")).toBe(false);
  expect(m("packages/a/b/.vite/x", "packages/*/.vite/**")).toBe(false);
  // never_touch reads the same way: a folder it names by wildcard is barred as a whole.
  expect(m("packages/ui/dist/index.js", "packages/*/dist")).toBe(true);

  const task = { schema_version:2, id:"drop-fotosessii-theme-v1", title:"t", risk:"medium", lane:"api", project_cwd:"/p",
    read_first:[], interfaces:[], invariants:[], out_of_scope:[], expected_outputs:["packages/agent-runtime/src/agent-task-policy.ts"],
    owns_paths:["apps/scenario-runner/src/executors/cocoon-write/**", cocoon, "packages/agent-runtime/src/agent-task-policy.ts"],
    never_touch:[], depends_on:[], verify:"tests",
    verification:[{ command:"npx tsc --noEmit", cwd:"/p/apps/scenario-runner" }] } as never;
  const produced = ["packages/agent-runtime/src/agent-task-policy.ts", "apps/scenario-runner/src/executors/cocoon-write/cocoon-write-executor.ts", cocoonTest];
  expect(classifyWriterOutput({ task, produced, contents:{ "packages/agent-runtime/src/agent-task-policy.ts":"x" },
    verifies:[{ command:"npx tsc --noEmit", exitCode:0, stdout:"", stderr:"" }] }).ok).toBe(true);
  expect(findUnownedChanges(produced, task)).toEqual([]);
});
