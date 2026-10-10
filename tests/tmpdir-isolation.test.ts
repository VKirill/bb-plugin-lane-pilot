import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it } from "vitest";

// tests/global-setup.ts points TMPDIR at one run directory that is removed after the run; a worker that still sees
// the real OS temp directory leaks every mkdtemp (the fake plugin host alone: ~0.5 MB per host, never disposed).
it("keeps every temp directory of a worker and of its children inside the run directory", () => {
  expect(basename(tmpdir())).toMatch(/^lp-vitest-\d+-/);
  for (const key of ["TMPDIR", "TEMP", "TMP"]) expect(process.env[key]).toBe(tmpdir());
  expect(dirname(mkdtempSync(join(tmpdir(), "probe-")))).toBe(tmpdir());
  const child = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').tmpdir())"], { encoding: "utf8" });
  expect(child).toBe(tmpdir());
  const shell = execFileSync("/bin/sh", ["-c", "printf %s \"$TMPDIR\""], { encoding: "utf8" });
  expect(shell).toBe(tmpdir());
});
