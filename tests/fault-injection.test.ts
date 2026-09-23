import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256FileOrNull } from "../src/hash";
import { INSTALL_PHASES } from "../src/install-runner";
import { installStack } from "../src/stack-ops";
import { snapshotGlobalOpenCursor } from "./npm-isolation";

const FALLBACK = join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack");
const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
function seed(home: string): void {
  mkdirSync(join(home, ".agents"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), `${JSON.stringify({ env: { KEEP: "1" } }, null, 2)}\n`);
  writeFileSync(join(home, ".agents/keep.txt"), "before\n");
}

describe("owned installStack bypasses legacy installer checkpoints", () => {
  for (const phase of INSTALL_PHASES) {
    it(`does not enter the legacy ${phase} checkpoint`, async () => {
      const home = mkdtempSync(join(tmpdir(), `lane-pilot-fault-${phase}-`));
      seed(home);
      const settingsBefore = await sha256FileOrNull(join(home, ".claude/settings.json"));
      const keepBefore = await sha256FileOrNull(join(home, ".agents/keep.txt"));
      const globalBefore = snapshotGlobalOpenCursor();
      try {
        const receipt = await installStack({
          requestedHostId: "host_test",
          homeDir: home,
          workspacePath: home,
          localFallbackPath: FALLBACK,
          guardSourcePath: GUARD,
          confirmExternalOps: false,
          stopAfterPhase: phase,
        });

        expect(receipt.status, receipt.notes.join("\n")).toBe("ok");
        expect(receipt.exitCode, receipt.notes.join("\n")).toBe(0);
        expect(receipt.notes.join("\n")).toMatch(/install\.sh/i);
        expect(existsSync(join(home, ".lane-pilot-phase"))).toBe(false);
        expect(existsSync(join(home, ".lane-pilot-npm-skipped"))).toBe(false);
        expect(snapshotGlobalOpenCursor()).toEqual(globalBefore);
        expect(await sha256FileOrNull(join(home, ".claude/settings.json"))).toBe(settingsBefore);
        expect(await sha256FileOrNull(join(home, ".agents/keep.txt"))).toBe(keepBefore);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
