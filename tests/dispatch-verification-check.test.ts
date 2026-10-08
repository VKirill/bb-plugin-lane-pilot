import { describe, expect, it } from "vitest";
import { findSandboxUnsafeMissingExcludes, parseSandboxUnsafePatterns } from "../src/rooms/critique/critique-coverage";

describe("sandbox-unsafe verification checking", () => {
  const unsafePatterns = [
    "tests/verification/**",
    "tests/scenarios.test.ts",
    "tests/pipeline.test.ts",
    "tests/acceptance-v2.test.ts",
    "tests/stability-drill.test.ts",
  ];

  it("parses sandbox unsafe patterns from string or array", () => {
    expect(parseSandboxUnsafePatterns(unsafePatterns)).toEqual(unsafePatterns);
    expect(parseSandboxUnsafePatterns("tests/verification/**, tests/scenarios.test.ts\ntests/pipeline.test.ts")).toEqual([
      "tests/verification/**",
      "tests/scenarios.test.ts",
      "tests/pipeline.test.ts",
    ]);
    expect(parseSandboxUnsafePatterns('["tests/verification/**", "tests/scenarios.test.ts"]')).toEqual([
      "tests/verification/**",
      "tests/scenarios.test.ts",
    ]);
  });

  it("flags missing exclusions for a bare vitest run", () => {
    const command = "npx vitest run";
    const missing = findSandboxUnsafeMissingExcludes(command, unsafePatterns);
    expect(missing).toEqual(unsafePatterns);
  });

  it("flags missing exclusions for vitest without excludes", () => {
    const command = "vitest run";
    const missing = findSandboxUnsafeMissingExcludes(command, unsafePatterns);
    expect(missing).toEqual(unsafePatterns);
  });

  it("detects when all unsafe patterns are excluded", () => {
    const command = `npx vitest run --exclude "tests/verification/**" --exclude "tests/scenarios.test.ts" --exclude "tests/pipeline.test.ts" --exclude "tests/acceptance-v2.test.ts" --exclude "tests/stability-drill.test.ts"`;
    const missing = findSandboxUnsafeMissingExcludes(command, unsafePatterns);
    expect(missing).toEqual([]);
  });

  it("returns only the un-excluded patterns when partially excluded", () => {
    const command = `npx vitest run --exclude "tests/verification/**" --exclude "tests/scenarios.test.ts"`;
    const missing = findSandboxUnsafeMissingExcludes(command, unsafePatterns);
    expect(missing).toEqual([
      "tests/pipeline.test.ts",
      "tests/acceptance-v2.test.ts",
      "tests/stability-drill.test.ts",
    ]);
  });

  it("ignores focused vitest commands targeting specific files", () => {
    const command = "npx vitest run tests/my-task.test.ts";
    const missing = findSandboxUnsafeMissingExcludes(command, unsafePatterns);
    expect(missing).toEqual([]);
  });

  it("treats a folder filter with a trailing slash as focused", () => {
    expect(findSandboxUnsafeMissingExcludes("npx vitest run tests/server/", unsafePatterns)).toEqual([]);
    expect(findSandboxUnsafeMissingExcludes("vitest run tests/server/ --exclude tests/x/", unsafePatterns)).toEqual([]);
  });

  it("does not read the value of a flag as a filter", () => {
    expect(findSandboxUnsafeMissingExcludes("npx vitest run --pool forks", unsafePatterns)).toEqual(unsafePatterns);
    expect(findSandboxUnsafeMissingExcludes("npx vitest run --retry 2 --maxWorkers 4", unsafePatterns)).toEqual(unsafePatterns);
    expect(findSandboxUnsafeMissingExcludes("npx vitest run --pool forks tests/a.test.ts", unsafePatterns)).toEqual([]);
  });
});
