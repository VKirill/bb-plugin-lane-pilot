import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { NATIVE_HOOK_SOURCES } from "../src/native-hook-sources";

// ripgrep's JSON output fails on a record over 64 KB; a writer's search then dies on one line.
it("keeps every tracked source and test line far below that limit, and the embedded hooks under 1000", () => {
  const files = execFileSync("git", ["ls-files", "src", "tests", "scripts", "lane-stack", "packages"], { encoding: "utf8" })
    .split("\n").filter((file) => /\.(ts|tsx|mjs|py)$/.test(file) && !file.startsWith("packages/settings-catalog/src/ui-catalog"));
  const long = files.flatMap((file) => readFileSync(file, "utf8").split("\n")
    .flatMap((line, index) => line.length > (file === "src/native-hook-sources.ts" ? 1000 : 8000) ? [`${file}:${index + 1} (${line.length})`] : []));
  expect(long).toEqual([]);
});

it("embeds the lane-stack hooks byte for byte", () => {
  for (const [name, source] of Object.entries(NATIVE_HOOK_SOURCES)) {
    expect(source).toBe(readFileSync(`lane-stack/hooks/${name}`, "utf8"));
  }
});
