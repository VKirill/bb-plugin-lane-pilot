// One scratch directory per vitest run. Tests (and @get-bb/plugin-sdk's createFakePluginHost, which makes a SQLite
// directory per host and removes it only on dispose()) create thousands of mkdtemp directories and most never clean
// up: ~15 GB per hour leaked into the OS temp directory. Every worker process inherits TMPDIR from here, so os.tmpdir()
// and mktemp point into this directory, and teardown removes it as a whole.
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "lp-vitest-";
let runDir = "";

/** Directories of runs that were killed before teardown (the pid in the name is gone) are removed on the next run. */
function sweepDeadRuns(root: string) {
  for (const name of readdirSync(root)) {
    const match = /^lp-vitest-(\d+)-/.exec(name);
    if (!match) continue;
    try { process.kill(Number(match[1]), 0); continue; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") continue;
    }
    rmSync(join(root, name), { recursive: true, force: true });
  }
}

export default function setup() {
  // Every project of the config runs this file (extends: true): the first one makes the directory, the others share it.
  if (process.env.LP_VITEST_RUN_DIR && existsSync(process.env.LP_VITEST_RUN_DIR)) return;
  const root = realpathSync(tmpdir());
  try { sweepDeadRuns(root); } catch { /* a busy temp root must not stop the run */ }
  runDir = mkdtempSync(join(root, `${PREFIX}${process.pid}-`));
  process.env.LP_VITEST_RUN_DIR = runDir;
  for (const key of ["TMPDIR", "TEMP", "TMP"]) process.env[key] = runDir;
  return function teardown() {
    if (runDir && existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
    delete process.env.LP_VITEST_RUN_DIR;
  };
}
