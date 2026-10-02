import { expect, it } from "vitest";
import { ownsPathsOverlap } from "../src/owns-paths";

it("lets disjoint tasks run side by side and holds back any that may touch one file", () => {
  expect(ownsPathsOverlap(["apps/bot/**"], ["apps/marketing/**"])).toBe(false);
  expect(ownsPathsOverlap(["apps/bot/src/a.ts"], ["apps/bot/src/b.ts"])).toBe(false);
  expect(ownsPathsOverlap(["apps/bot/**"], ["apps/bot/src/a.ts"])).toBe(true);
  expect(ownsPathsOverlap(["apps/bot/"], ["apps/bot/src/handlers/__tests__/x.test.ts"])).toBe(true);
  expect(ownsPathsOverlap(["packages/contracts/src/*.ts"], ["packages/contracts/src/x.ts"])).toBe(true);
  expect(ownsPathsOverlap(["*.md"], ["apps/bot/README.md"])).toBe(true);
  expect(ownsPathsOverlap(["apps/bot-thin/**"], ["apps/bot/**"])).toBe(false);
});
