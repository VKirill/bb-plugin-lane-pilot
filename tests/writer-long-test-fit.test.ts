import { expect, it } from "vitest";
import { observeTestEditHold } from "./sma/r01-world-d";

it.each([false, true])("a weakened assertion after line 400 is held and only its complete approval releases it (in place: %s)", async (inPlace) => {
  const seen = await observeTestEditHold(2100, undefined, inPlace);
  expect(seen.asked.reason).toMatch(/^test_edit_hold:/);
  expect(seen.asked.held).toEqual([{ path: "tests/sum.test.ts", afterSha256: seen.afterSha }]);
  expect(seen.notAsked.reason).toMatch(/^test_fit:/);
  expect(seen.allowed.held).toEqual([]);
  expect(seen.allowed.reason).toMatch(/^owner_word:/);
  expect(seen.otherEdit.reason).toMatch(/^test_edit_hold:/);
}, 120_000);

it.each([
  ["changed", "changed during the read"],
  ["stalled", "could not be read completely"],
  ["failed", "next page unavailable"],
] as const)("a %s paged read cannot approve a partial reference test", async (fault, message) => {
  await expect(observeTestEditHold(2100, fault)).rejects.toThrow(message);
}, 120_000);

it("an oversized HEAD reference fails closed before test-fit processing", async () => {
  await expect(observeTestEditHold(100001, undefined, true)).rejects.toThrow("HEAD exceeds the complete-read limit");
}, 120_000);

it("a complete last page cannot exceed the line limit", async () => {
  await expect(observeTestEditHold(100001)).rejects.toThrow("could not be read completely");
}, 120_000);
