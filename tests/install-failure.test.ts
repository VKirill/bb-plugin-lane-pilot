import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installStack } from "../src/stack-ops";
import { SnapshotReadError, rollbackSnapshot, takeSnapshot } from "../src/snapshot";
import { isolatedTestPath, linkSafeTools } from "./npm-isolation";

const FALLBACK = join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack");
const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");

describe("install failure rollback and snapshot integrity", () => {
  it("D3 rolls back after install.sh exit 73 and skips guard/connect/finalize", async () => {
    const home = mkdtempSync(join(tmpdir(), "lane-pilot-d3-"));
    const toolsDir = join(home, "safe-tools");
    const oldInstall = '{"source_sha":"old"}\n';
    const oldSettings = '{"env":{"KEEP":"1"}}\n';
    mkdirSync(join(home, ".agents"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".agents/install.json"), oldInstall);
    writeFileSync(join(home, ".claude/settings.json"), oldSettings);
    linkSafeTools(toolsDir);
    rmSync(join(toolsDir, "rsync"), { force: true });
    writeFileSync(join(toolsDir, "rsync"), "#!/bin/sh\necho injected-rsync-failure >&2\nexit 73\n");
    chmodSync(join(toolsDir, "rsync"), 0o755);
    process.env.LANE_PILOT_SAFE_PATH = isolatedTestPath([toolsDir]);
    try {
      const receipt = await installStack({
        requestedHostId: "host_test",
        homeDir: home,
        workspacePath: home,
        receiptDir: join(home, "receipts"),
        confirmExternalOps: false,
        localFallbackPath: FALLBACK,
        guardSourcePath: GUARD,
        moduleUrl: import.meta.url,
      });
      expect(receipt.exitCode).toBe(73);
      expect(receipt.status).toBe("rolled_back");
      expect(receipt.notes.join("\n")).toContain("rollback verified");
      expect(receipt.notes.join("\n")).toContain("guard/connect/finalize skipped");
      expect(existsSync(join(home, ".agents/install.json"))).toBe(true);
      expect(readFileSync(join(home, ".agents/install.json"), "utf8")).toBe(oldInstall);
      expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe(oldSettings);
      expect(existsSync(join(home, ".agents/bin"))).toBe(false);
      expect(existsSync(join(home, ".agents/hooks"))).toBe(false);
      expect(existsSync(join(home, ".agents/hooks/guard_shell.py"))).toBe(false);
    } finally {
      delete process.env.LANE_PILOT_SAFE_PATH;
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  it("D4 aborts snapshot on unreadable existing file and does not delete it", async () => {
    const home = mkdtempSync(join(tmpdir(), "lane-pilot-d4-"));
    const protectedFile = join(home, ".winnow", "env");
    mkdirSync(join(home, ".winnow"), { recursive: true });
    writeFileSync(protectedFile, "synthetic-existing-content\n");
    chmodSync(protectedFile, 0o000);
    try {
      await expect(takeSnapshot({ homeDir: home })).rejects.toBeInstanceOf(SnapshotReadError);
      expect(existsSync(protectedFile)).toBe(true);
      const snapshots = join(home, ".agents/lane-pilot/snapshots");
      expect(existsSync(snapshots) ? readdirSync(snapshots) : []).toEqual([]);
    } finally {
      chmodSync(protectedFile, 0o644);
    }
    expect(readFileSync(protectedFile, "utf8")).toBe("synthetic-existing-content\n");
    rmSync(home, { recursive: true, force: true });
  });

  it("D4 rollback of an absent-marked file is not produced for unreadable paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "lane-pilot-d4-rollback-"));
    const protectedFile = join(home, ".winnow", "env");
    mkdirSync(join(home, ".winnow"), { recursive: true });
    writeFileSync(protectedFile, "keep-me\n");
    chmodSync(protectedFile, 0o000);
    try {
      await expect(takeSnapshot({ homeDir: home })).rejects.toBeInstanceOf(SnapshotReadError);
      const leftover = join(home, ".agents/lane-pilot/snapshots");
      if (existsSync(leftover)) {
        for (const name of readdirSync(leftover)) {
          await rollbackSnapshot(join(leftover, name));
        }
      }
    } finally {
      chmodSync(protectedFile, 0o644);
    }
    expect(existsSync(protectedFile)).toBe(true);
    expect(readFileSync(protectedFile, "utf8")).toBe("keep-me\n");
    rmSync(home, { recursive: true, force: true });
  });
});
