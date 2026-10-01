import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** Claude Lane Stack v1.38.0: the upstream these tests compare against, pinned so results do not drift. */
export const UPSTREAM_SHA = "747a9ff9b2fa4ffdcf5c65c8d07eff2b9386a821";

const root = process.cwd();
const LEGACY = join(root, ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack");
const CACHE = join(root, "node_modules/.cache", `lane-stack-${UPSTREAM_SHA.slice(0, 12)}`);

/**
 * The pinned upstream tree, or null when no source is available on this machine.
 * Order: LANE_STACK_FIXTURE, the original chat snapshot, a cached export, then a `git archive` of the
 * pinned commit from LANE_STACK_REPO or the sibling claude-lane-stack checkout.
 */
function resolveUpstream(): string | null {
  const ready = (dir: string | undefined) => Boolean(dir && existsSync(join(dir, "install.sh")));
  const fixture = process.env.LANE_STACK_FIXTURE;
  if (ready(fixture)) return fixture!;
  if (ready(LEGACY)) return LEGACY;
  if (ready(CACHE)) return CACHE;
  for (const repo of [process.env.LANE_STACK_REPO, resolve(root, "../claude-lane-stack")]) {
    if (!repo || !existsSync(join(repo, ".git"))) continue;
    const staging = `${CACHE}.tmp-${process.pid}`;
    try {
      mkdirSync(staging, { recursive: true });
      execFileSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", repo, UPSTREAM_SHA, staging], { stdio: "pipe" });
      if (!existsSync(CACHE)) renameSync(staging, CACHE);
      else rmSync(staging, { recursive: true, force: true });
      if (ready(CACHE)) return CACHE;
    } catch {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return null;
}

export const UPSTREAM_ROOT = resolveUpstream();
/** For describe.skipIf: tests that compare with upstream skip with a reason instead of crashing at import. */
export const NO_UPSTREAM = UPSTREAM_ROOT === null;
export const upstreamPath = (...parts: string[]) => join(UPSTREAM_ROOT ?? LEGACY, ...parts);
