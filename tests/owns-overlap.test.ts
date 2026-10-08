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
  const { findUnownedChanges } = await import("../src/verification/ownership");
  const task = { project_cwd: "/p", owns_paths: ["apps/api/src/**greeting-card*", "packages/db/prisma/migrations/*_greeting_cards_core/**"], never_touch: [], verification: [] } as never;
  expect(findUnownedChanges(["apps/api/src/routes/greeting-cards.ts", "packages/db/prisma/migrations/20261002_greeting_cards_core/migration.sql"], task)).toEqual([]);
  expect(findUnownedChanges(["apps/api/src/routes/other.ts"], task)).toEqual(["apps/api/src/routes/other.ts"]);
});
