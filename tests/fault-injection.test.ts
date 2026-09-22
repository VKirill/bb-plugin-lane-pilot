import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256FileOrNull } from "../src/hash";
import { INSTALL_PHASES, isolatedNpmPrefix } from "../src/install-runner";
import { rollbackSnapshot, takeSnapshot, verifyRollback } from "../src/snapshot";
import { isolatedTestPath, linkSafeTools, snapshotGlobalOpenCursor } from "./npm-isolation";

const FALLBACK = join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack");
const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const TSX_CLI = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const FAULT_SCRIPT = join(process.cwd(), "scripts/fault-install-stack.ts");

function seed(home: string): void {
  mkdirSync(join(home, ".agents"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), `${JSON.stringify({ env: { KEEP: "1" } }, null, 2)}\n`);
  writeFileSync(join(home, ".agents/keep.txt"), "before\n");
}

describe("fault-injection §11 five SIGKILL points on production installStack", () => {
  for (const phase of INSTALL_PHASES) {
    it(`restores after SIGKILL of installStack at ${phase}`, async () => {
      const home = mkdtempSync(join(tmpdir(), `lane-pilot-fault-${phase}-`));
      const toolsDir = join(home, "safe-tools");
      seed(home);
      linkSafeTools(toolsDir);
      const settingsBefore = await sha256FileOrNull(join(home, ".claude/settings.json"));
      const keepBefore = await sha256FileOrNull(join(home, ".agents/keep.txt"));
      const globalBefore = snapshotGlobalOpenCursor();
      const snap = await takeSnapshot({ homeDir: home });
      expect(existsSync(TSX_CLI), "pinned local tsx is required; do not use npx").toBe(true);
      const child = spawnSync(process.execPath, ["--import", "tsx", FAULT_SCRIPT], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          npm_config_prefix: isolatedNpmPrefix(home),
          NPM_CONFIG_PREFIX: isolatedNpmPrefix(home),
          LANE_PILOT_SAFE_PATH: isolatedTestPath([toolsDir]),
          LANE_PILOT_FALLBACK: FALLBACK,
          LANE_PILOT_GUARD: GUARD,
          LANE_PILOT_STOP_AFTER: phase,
        },
        encoding: "utf8",
      });
      const sigkill = child.signal === "SIGKILL" || child.status === 137;
      if (!sigkill) {
        throw new Error(
          `expected SIGKILL at ${phase}, got signal=${child.signal} status=${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
        );
      }
      expect(readFileSync(join(home, ".lane-pilot-phase"), "utf8").trim()).toBe(phase);
      if (phase === "npm") {
        expect(readFileSync(join(home, ".lane-pilot-npm-skipped"), "utf8")).toContain("не применимо без подтверждения");
      }
      expect(snapshotGlobalOpenCursor()).toEqual(globalBefore);
      await rollbackSnapshot(snap.snapshotPath);
      const verified = await verifyRollback(snap.snapshotPath);
      expect(verified.ok, JSON.stringify(verified.mismatches, null, 2)).toBe(true);
      expect(await sha256FileOrNull(join(home, ".claude/settings.json"))).toBe(settingsBefore);
      expect(await sha256FileOrNull(join(home, ".agents/keep.txt"))).toBe(keepBefore);
      rmSync(home, { recursive: true, force: true });
    }, 180_000);
  }
});
