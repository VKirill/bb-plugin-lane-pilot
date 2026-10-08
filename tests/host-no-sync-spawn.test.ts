import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { buildGraph, runtimeClosure } from "../scripts/refactor/graph";

/**
 * A host worker blocked in spawnSync cannot take the daemon's next call or its cancel: the call misses its deadline
 * and the daemon SIGKILLs the worker with every call in it (OVH, 2026-10-05). Nothing the host handlers can reach
 * may start a child process synchronously. A file that must, goes here with the one line that says why.
 */
const ALLOWED: Record<string, string> = {};

const root = resolve(__dirname, "..");
const SYNC_SPAWN = /\b(?:spawnSync|execFileSync|execSync)\b/g;

const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The project files host.ts loads: static and dynamic imports, workspace packages included, type-only imports left out (they load nothing). */
function hostClosure(): string[] {
  return [...runtimeClosure(buildGraph(), "host.ts")].sort();
}

it("reaches the host handlers' code (so the scan below cannot go quiet by finding nothing)", () => {
  const files = hostClosure();
  for (const expected of ["host.ts", "src/host-handlers.ts", "src/jobs.ts", "src/verification/git-integrate.ts", "src/coexistence/index.ts", "src/stack-ops.ts", "packages/kit/src/spawn-async.ts"]) {
    expect(files).toContain(expected);
  }
  expect(files.some((file) => file.startsWith("src/server/"))).toBe(false);
});

it("starts no child process synchronously anywhere the host handlers can reach, but where listed with a reason", () => {
  const found: Record<string, number> = {};
  for (const file of hostClosure()) {
    const hits = withoutComments(readFileSync(join(root, file), "utf8")).match(SYNC_SPAWN)?.length ?? 0;
    if (hits) found[file] = hits;
  }
  expect(Object.keys(found).filter((file) => !ALLOWED[file])).toEqual([]);
  // An entry nobody needs any more is removed, so the list never outlives the code it excuses.
  expect(Object.keys(ALLOWED).filter((file) => !found[file])).toEqual([]);
  for (const [file, reason] of Object.entries(ALLOWED)) expect(reason, file).toMatch(/^[^\n]{10,200}$/);
});
