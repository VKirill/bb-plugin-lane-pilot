import { describe, expect, it } from "vitest";
import { cacheHitsNote, extractCacheHits, extractFailingFiles, extractFailingTests } from "../../src/rooms/verification/gate-output";

// An excerpt of the SelfyStudio gate log of 2026-10-09 (turbo + vitest, with colour codes).
const TURBO_RUN = [
  "@selfystudio/events:build: cache hit, replaying logs 69a7bad3c312d12e",
  "@selfystudio/scene-compile:build: cache miss, executing 010fc5c70c1ce43f",
  "@selfystudio/admin:test:  \u001b[32m✓\u001b[39m plugins/seo-landings/pages/__tests__/prompts.spec.ts \u001b[2m(30 tests)\u001b[22m 274ms",
  "@selfystudio/admin:test:  ❯ plugins/scenarios/__tests__/scenario-catalog.spec.ts (2 tests | 2 failed) 71ms",
  "@selfystudio/image-providers:test: stdout | src/legacy/providers/__tests__/gpt-image-client.test.ts > generateImageWithGptImage > does not replay",
  "@selfystudio/image-providers:test:  \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m src/legacy/__tests__/muse-fal-fallback.test.ts > image-orchestrator muse-* > stops after a policy error",
  "@selfystudio/image-providers:test:  FAIL  src/legacy/__tests__/muse-fal-fallback.test.ts > image-orchestrator muse-* > stops on the plain entry",
  "@selfystudio/events:test: cache hit, replaying logs 9350b0a1a0609b26",
  " Tasks:    52 successful, 73 total",
  "Cached:    49 cached, 73 total",
].join("\n");

describe("failing tests in a gate run's output", () => {
  it("names only the files that failed, with the turbo package that ran them", () => {
    expect(extractFailingTests(TURBO_RUN)).toEqual([
      { file: "plugins/scenarios/__tests__/scenario-catalog.spec.ts", workspacePackage: "@selfystudio/admin" },
      { file: "src/legacy/__tests__/muse-fal-fallback.test.ts", workspacePackage: "@selfystudio/image-providers" },
    ]);
  });

  it("does not take passing files or console-output headers for failures", () => {
    const files = extractFailingFiles(TURBO_RUN);
    expect(files).not.toContain("plugins/seo-landings/pages/__tests__/prompts.spec.ts");
    expect(files).not.toContain("src/legacy/providers/__tests__/gpt-image-client.test.ts");
  });

  it("reads plain vitest, jest and tsc output", () => {
    expect(extractFailingFiles(" ❯ tests/foo.test.ts:24:5\n FAIL tests/bar.spec.ts\n")).toEqual(["tests/foo.test.ts", "tests/bar.spec.ts"]);
    expect(extractFailingFiles("FAIL  src/a.test.js\n  ● suite › case\n")).toEqual(["src/a.test.js"]);
    expect(extractFailingFiles("src/rooms/x.ts:42:10 - error TS2304: Cannot find name 'foo'.\n")).toEqual(["src/rooms/x.ts"]);
  });

  it("falls back to a test file named on a line that does not say it passed, only when nothing says failed", () => {
    expect(extractFailingFiles("something broke in tests/odd.test.ts\n ✓ tests/fine.test.ts (3 tests)\n")).toEqual(["tests/odd.test.ts"]);
  });
});

describe("turbo cache hits", () => {
  it("lists the tasks answered from the cache and turbo's own summary", () => {
    const report = extractCacheHits(TURBO_RUN);
    expect(report.hits).toEqual(["@selfystudio/events#build", "@selfystudio/events#test"]);
    expect(report.summary).toBe("49 cached, 73 total");
    expect(cacheHitsNote(report)).toContain("@selfystudio/events#test");
    expect(cacheHitsNote(report)).toContain("49 cached, 73 total");
  });

  it("says nothing when no task was a cache hit", () => {
    expect(cacheHitsNote(extractCacheHits("npm test\n 3 passed"))).toBe("");
  });
});
