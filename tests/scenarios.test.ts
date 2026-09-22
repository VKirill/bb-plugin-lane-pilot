import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, describe, expect, it } from "vitest";
import { TARGET_SHA } from "../src/constants";
import { importSettingsOnce, openDatabase } from "../src/database";
import { sha256FileOrNull } from "../src/hash";
import {
  connectOpencodeStack,
  detectStack,
  importConfigStack,
  installStack,
} from "../src/stack-ops";

const FALLBACK = join(process.cwd(), ".bb/chats/thr_2spsxrsutt/tmp/claude-lane-stack");
const home = mkdtempSync(join(tmpdir(), "lane-pilot-s18-"));
const receiptDir = join(home, "receipts");
const workspace = join(home, "ws");

function seedHome(target: string): void {
  mkdirSync(join(target, ".agents"), { recursive: true });
  mkdirSync(join(target, ".claude"), { recursive: true });
  mkdirSync(join(target, ".config/opencode"), { recursive: true });
  mkdirSync(join(target, "ws/.claude"), { recursive: true });
  writeFileSync(join(target, ".agents/install.json"), `${JSON.stringify({
    schema_version: 1,
    source_sha: "7ca2275c5ff1c497030e1688770bf0ffaf064de1",
    version: "old",
  }, null, 2)}\n`);
  writeFileSync(join(target, ".agents/routing.profile.yaml"), "schema_version: 1\nlanes: []\n");
  writeFileSync(join(target, ".agents/night-shift.yaml"), "enabled: false\n");
  writeFileSync(join(target, ".agents/capabilities.json"), "{}\n");
  writeFileSync(join(target, ".claude/settings.json"), `${JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo 1" }] }] },
  }, null, 2)}\n`);
  writeFileSync(join(target, ".config/opencode/opencode.jsonc"), `{
  // keep
  "plugin": ["./plugins/lane-context.ts"]
}
`);
  writeFileSync(join(target, "ws/.claude/settings.json"), `${JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: "Bash|Edit|Write",
        hooks: [{
          type: "command",
          command: `python3 ${process.cwd()}/scripts/record_and_guard.py ${target}/ws/hook.jsonl ${process.cwd()}/lane-stack/hooks/guard_shell.py`,
        }],
      }],
    },
  }, null, 2)}\n`);
}

seedHome(home);

const ctx = {
  requestedHostId: "host_test",
  homeDir: home,
  workspacePath: workspace,
  receiptDir,
  confirmExternalOps: false,
  localFallbackPath: FALLBACK,
  guardSourcePath: join(process.cwd(), "lane-stack/hooks/guard_shell.py"),
  pmWorkspacePath: workspace,
  moduleUrl: import.meta.url,
};

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("S1–S8 isolated HOME", () => {
  it("S2 detect sees a non-target SHA", async () => {
    const detected = await detectStack(ctx);
    expect(detected.scenario).toBe("S2");
    expect(detected.matchesTarget).toBe(false);
  });

  it("S2/S3 install reaches target SHA without external ops or S8 writes", async () => {
    const s8Before = {
      routing: await sha256FileOrNull(join(home, ".agents/routing.profile.yaml")),
      night: await sha256FileOrNull(join(home, ".agents/night-shift.yaml")),
      caps: await sha256FileOrNull(join(home, ".agents/capabilities.json")),
    };
    const receipt = await installStack(ctx);
    expect(receipt.exitCode, receipt.notes.join("\n")).toBe(0);
    expect(receipt.sourceSha).toBe(TARGET_SHA);
    expect(receipt.skippedExternalOps.length).toBeGreaterThan(0);
    expect(receipt.warning).toContain("откат не гарантированно");
    expect(await sha256FileOrNull(join(home, ".agents/routing.profile.yaml"))).toBe(s8Before.routing);
    expect(await sha256FileOrNull(join(home, ".agents/night-shift.yaml"))).toBe(s8Before.night);
    expect(await sha256FileOrNull(join(home, ".agents/capabilities.json"))).toBe(s8Before.caps);
    expect(readFileSync(join(home, ".agents/hooks/guard_shell.py"), "utf8")).toContain("LANE_PILOT_PM_AGENT_TYPES");
    expect(readFileSync(join(workspace, ".claude/settings.json"), "utf8")).toContain(`${home}/.agents/hooks/guard_shell.py`);
    const detected = await detectStack(ctx);
    expect(detected.scenario).toBe("S1");
  }, 180_000);

  it("S1/S4 second install is a no-op and does not duplicate hooks", async () => {
    const settingsBefore = readFileSync(join(home, ".claude/settings.json"), "utf8");
    const receipt = await installStack(ctx);
    expect(receipt.scenario).toBe("S1");
    expect(receipt.filesChanged).toEqual([]);
    expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe(settingsBefore);
    const parsed = JSON.parse(settingsBefore) as { hooks?: { PreToolUse?: unknown[] } };
    const hooks = parsed.hooks?.PreToolUse ?? [];
    expect(hooks.length).toBeLessThanOrEqual(4);
  });

  it("S5 OpenCode JSONC is additive and idempotent", async () => {
    const first = await connectOpencodeStack(ctx);
    expect(first.scenario).toBe("S5");
    expect(first.exitCode).toBe(0);
    const text = readFileSync(join(home, ".config/opencode/opencode.jsonc"), "utf8");
    expect(text).toContain("./plugins/opencode-lane.ts");
    expect(text).not.toContain("./plugins/lane-context.ts");
    expect(text).toContain("keep");
    const second = await connectOpencodeStack(ctx);
    expect(second.filesChanged[0]?.sha256After).toBe(first.filesChanged[0]?.sha256After);
    expect(second.notes.some((note) => note.includes("no-op") || note.includes("second pass"))).toBe(true);
  });

  it("S6 skips when OpenCode config and binary are absent", async () => {
    const empty = mkdtempSync(join(tmpdir(), "lane-pilot-s6-"));
    try {
      const result = await connectOpencodeStack({
        requestedHostId: "host_test",
        homeDir: empty,
      });
      expect(result.scenario).toBe("S6");
      expect(result.filesChanged).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("S7 imports YAML once and never again", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const payload = await importConfigStack(ctx);
    expect(payload.imported.routingProfile?.text).toContain("schema_version");
    expect(importSettingsOnce(db, "proj_s7", payload.imported).imported).toBe(true);
    expect(importSettingsOnce(db, "proj_s7", payload.imported).imported).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("S3 detect reports missing install.json", async () => {
    const empty = mkdtempSync(join(tmpdir(), "lane-pilot-s3-"));
    try {
      const detected = await detectStack({ requestedHostId: "host_test", homeDir: empty, workspacePath: empty });
      expect(detected.scenario).toBe("S3");
      expect(detected.laneStack.present).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
