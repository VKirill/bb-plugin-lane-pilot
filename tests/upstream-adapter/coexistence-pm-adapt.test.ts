import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installStack } from "../../src/rooms/native-install/stack-ops";
import { registerHomeCleanup, hostId, makeHome, seedCompatibleEngine, makeGitRepo, treeHash } from "./coexistence-helpers";

registerHomeCleanup();

describe("typed coexistence operations: the PM workspace", () => {
  it.each([
    { marker: "absent", foreignGuard: false },
    { marker: "absent", foreignGuard: true },
    { marker: "corrupt", foreignGuard: true },
    { marker: "corrupt", foreignGuard: false },
    { marker: "incompatible", foreignGuard: true },
    { marker: "incompatible", foreignGuard: false },
  ] as const)("keeps ordinary configs and adapts PM for $marker marker / foreign guard=$foreignGuard", async ({ marker, foreignGuard }) => {
    const home = await makeHome();
    const pmWorkspace = join(home, "pm-workspace");
    const homeClaude = join(home, ".claude/settings.json");
    const homeOpenCode = join(home, ".config/opencode/opencode.json");
    const pmSettings = join(pmWorkspace, ".claude/settings.json");
    const foreignGuardPath = join(home, ".agents/hooks/guard_shell.py");
    const ownedGuardPath = join(home, ".agents/lane-pilot/pm/guard_shell.py");
    const markerPath = join(home, ".agents/install.json");
    const fallback = join(home, "fixture-compatible-engine");

    await seedCompatibleEngine(fallback);
    await makeGitRepo(fallback);
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(homeClaude, '{"hooks":{"UserHook":"keep"},"theme":"dark"}\n');
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(homeOpenCode, '{"model":"user/model","plugin":["./plugins/user.ts"]}\n');
    await mkdir(join(pmWorkspace, ".claude"), { recursive: true });
    await writeFile(pmSettings, `{\n  // keep this user's comment\n  "model": "pm/model",\n  "hooks": {\n    "PreToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"python3 /user/guard.py"}]}]\n  }\n}\n`);

    if (marker === "corrupt") {
      await mkdir(join(home, ".agents"), { recursive: true });
      await writeFile(markerPath, '{broken marker\n');
    } else if (marker === "incompatible") {
      const custom = join(home, ".agents/custom-lane-stack");
      await seedCompatibleEngine(custom, ["opencode.hook.tool_execute_after"]);
      await mkdir(join(home, ".agents"), { recursive: true });
      await writeFile(markerPath, `${JSON.stringify({ source_sha: "user-custom-incompatible", source_repo: custom, version: "custom" })}\n`);
    }
    if (foreignGuard) {
      await mkdir(join(home, ".agents/hooks"), { recursive: true });
      await writeFile(foreignGuardPath, "foreign-user-guard\n");
    }

    const protectedBefore = {
      claude: await treeHash(homeClaude),
      opencode: await treeHash(homeOpenCode),
      marker: await treeHash(markerPath),
      foreignGuard: await treeHash(foreignGuardPath),
    };
    const ctx = {
      requestedHostId: hostId,
      homeDir: home,
      localFallbackPath: fallback,
      pmWorkspacePath: pmWorkspace,
      guardSourcePath: join(process.cwd(), "lane-stack/hooks/guard_shell.py"),
      moduleUrl: import.meta.url,
    };
    const receipt = await installStack(ctx);
    expect(receipt.exitCode, receipt.notes.join("\n")).toBe(0);
    expect(receipt.scenario).toBe("S1");
    expect(await treeHash(ownedGuardPath)).toBeTruthy();
    expect(await readFile(ownedGuardPath, "utf8")).toContain("LANE_PILOT_PM_AGENT_TYPES");
    expect(await treeHash(foreignGuardPath)).toBe(protectedBefore.foreignGuard);
    expect({
      claude: await treeHash(homeClaude),
      opencode: await treeHash(homeOpenCode),
      marker: await treeHash(markerPath),
      foreignGuard: await treeHash(foreignGuardPath),
    }).toEqual(protectedBefore);

    const configured = await readFile(pmSettings, "utf8");
    expect(configured).toContain("// keep this user's comment");
    expect(configured).toContain('"model": "pm/model"');
    expect(configured).toContain("python3 /user/guard.py");
    expect(configured).toContain(`python3 '${ownedGuardPath}'`);
    expect(configured.match(/python3 '\/.*lane-pilot\/pm\/guard_shell\.py'/g)).toHaveLength(1);

    const settingsAfterFirst = await treeHash(pmSettings);
    const repeated = await installStack(ctx);
    expect(repeated.exitCode, repeated.notes.join("\n")).toBe(0);
    expect(repeated.scenario).toBe("S1");
    expect(repeated.filesChanged).toEqual([]);
    expect(await treeHash(pmSettings)).toBe(settingsAfterFirst);
  });
});
