import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256FileOrNull } from "../src/hash";
import { rollbackSnapshot, takeSnapshot, verifyRollback } from "../src/snapshot";

const STACK = join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack");
const PHASES = ["mkdir", "rsync", "settings", "npm", "install_json"] as const;

function seed(home: string): void {
  mkdirSync(join(home, ".agents"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), `${JSON.stringify({ env: { KEEP: "1" } }, null, 2)}\n`);
  writeFileSync(join(home, ".agents/keep.txt"), "before\n");
}

describe("fault-injection §11 five SIGKILL points", () => {
  for (const phase of PHASES) {
    it(`restores after SIGKILL at ${phase}`, async () => {
      const home = mkdtempSync(join(tmpdir(), `lane-pilot-fault-${phase}-`));
      seed(home);
      const settingsBefore = await sha256FileOrNull(join(home, ".claude/settings.json"));
      const keepBefore = await sha256FileOrNull(join(home, ".agents/keep.txt"));
      const snap = await takeSnapshot({ homeDir: home });
      const child = spawnSync(process.execPath, [join(process.cwd(), "scripts/phased-install.mjs"), phase], {
        env: {
          ...process.env,
          HOME: home,
          STACK_ROOT: STACK,
          LANE_PILOT_CONFIRM_EXTERNAL: "0",
        },
        encoding: "utf8",
      });
      expect(child.signal === "SIGKILL" || child.status !== 0).toBe(true);
      expect(readFileSync(join(home, ".lane-pilot-phase"), "utf8").trim()).toBe(phase);
      if (phase === "npm") {
        expect(readFileSync(join(home, ".lane-pilot-npm-skipped"), "utf8")).toContain("не применимо без подтверждения");
      }
      await rollbackSnapshot(snap.snapshotPath);
      const verified = await verifyRollback(snap.snapshotPath);
      expect(verified.ok, JSON.stringify(verified.mismatches, null, 2)).toBe(true);
      expect(await sha256FileOrNull(join(home, ".claude/settings.json"))).toBe(settingsBefore);
      expect(await sha256FileOrNull(join(home, ".agents/keep.txt"))).toBe(keepBefore);
      rmSync(home, { recursive: true, force: true });
    }, 60_000);
  }
});
