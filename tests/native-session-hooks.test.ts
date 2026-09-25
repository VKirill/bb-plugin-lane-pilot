import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { NATIVE_HOOK_SOURCES } from "../src/native-hook-sources";
import { lpBridgeCatalogNames, materializeNativeHookSession, NATIVE_LP_BRIDGE_TOOLS, unionLpBridgeTools } from "../src/native-session-hooks";

it("names only bb-bridge LP tools and does not invent a full allowlist", () => {
  const names = lpBridgeCatalogNames();
  expect(names).toEqual(NATIVE_LP_BRIDGE_TOOLS.map((name) => `mcp__bb-bridge__${name}`));
  expect(names).toContain("mcp__bb-bridge__lane_pilot_read");
  expect(names.some((name) => name === "Read" || name === "Write" || name === "Bash")).toBe(false);
});

it("unions LP bridge names onto an existing allowlist without a wildcard", () => {
  const next = unionLpBridgeTools(["Read", "Write", "Bash"]);
  expect(next.slice(0, 3)).toEqual(["Read", "Write", "Bash"]);
  expect(next).toContain("mcp__bb-bridge__lane_pilot_read");
  expect(next).not.toContain("*");
});

it("materializes only bundled hooks when cwd is not known yet", async () => {
  const dest = join(await mkdtemp(join(tmpdir(), "lp-native-hooks-host-")), "session");
  const result = await materializeNativeHookSession({
    destDir: dest,
    moduleUrl: new URL("../src/native-session-hooks.ts", import.meta.url).href,
  });
  expect(await readFile(join(dest, "hooks", "inject_agent_type.py"), "utf8")).toBe(
    NATIVE_HOOK_SOURCES["inject_agent_type.py"],
  );
  expect(await readFile(join(dest, "hooks", "guard_shell.py"), "utf8")).toBe(
    NATIVE_HOOK_SOURCES["guard_shell.py"],
  );
  const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain("guard_shell.py");
});

it("copies original hook modules into the session dir and does not write home Claude files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-native-hooks-"));
  const cwd = join(root, "project");
  const dest = join(root, "session");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  const original = join(root, "orig_guard.py");
  await writeFile(original, "print('orig')\n");
  await writeFile(join(cwd, ".claude/settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `python3 ${original}` }] }] },
  }));
  const homeClaude = join(root, "fake-home-claude");
  await mkdir(homeClaude, { recursive: true });
  const result = await materializeNativeHookSession({
    cwd,
    destDir: dest,
    moduleUrl: new URL("../src/native-session-hooks.ts", import.meta.url).href,
  });
  const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
  expect(command).toContain(join(dest, "hooks", "inject_agent_type.py"));
  expect(command).toContain("orig_guard.py");
  expect(command).toContain(dest);
  expect(result.settingsPath.startsWith(dest)).toBe(true);
  await expect(stat(join(homeClaude, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("writes bundled hook sources when host artifact has no lane-stack tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "lp-native-hooks-artifact-"));
  const cwd = join(root, "project");
  const dest = join(root, "session");
  const artifact = join(root, "plugin-host-artifacts", "lane-pilot", "hash");
  await mkdir(cwd, { recursive: true });
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "host.mjs"), "export {}\n");
  const result = await materializeNativeHookSession({
    cwd,
    destDir: dest,
    moduleUrl: pathToFileURL(join(artifact, "host.mjs")).href,
  });
  expect(await readFile(join(dest, "hooks", "inject_agent_type.py"), "utf8")).toBe(
    NATIVE_HOOK_SOURCES["inject_agent_type.py"],
  );
  expect(await readFile(join(dest, "hooks", "guard_shell.py"), "utf8")).toBe(
    NATIVE_HOOK_SOURCES["guard_shell.py"],
  );
  expect(await readFile(join(dest, "hooks", "lib_payload.py"), "utf8")).toBe(
    NATIVE_HOOK_SOURCES["lib_payload.py"],
  );
  expect(result.settingsPath.startsWith(dest)).toBe(true);
});

it("keeps bundled hook sources equal to lane-stack files", async () => {
  for (const name of Object.keys(NATIVE_HOOK_SOURCES) as Array<keyof typeof NATIVE_HOOK_SOURCES>) {
    expect(await readFile(join(process.cwd(), "lane-stack/hooks", name), "utf8")).toBe(NATIVE_HOOK_SOURCES[name]);
  }
});

it("injects the namespaced Claude agentSetting only when agent_type is missing", () => {
  const inject = join(process.cwd(), "lane-stack/hooks/inject_agent_type.py");
  const inner = join(process.cwd(), "lane-stack/hooks/inject_agent_type.py");
  const echo = ["python3", "-c", "import sys; print(sys.stdin.read())"];
  const env = { ...process.env, LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" };
  const filled = spawnSync("python3", [inject, "--", ...echo], {
    input: JSON.stringify({ tool_name: "Write" }),
    encoding: "utf8",
    env,
  });
  expect(JSON.parse(filled.stdout).agent_type).toBe("lane-stack:dev-orchestrator");
  const kept = spawnSync("python3", [inner, "--", ...echo], {
    input: JSON.stringify({ agent_type: "lane-stack:dev-orchestrator", tool_name: "Read" }),
    encoding: "utf8",
    env: { ...process.env, LANE_PILOT_AGENT_TYPE: "dev-orchestrator" },
  });
  expect(JSON.parse(kept.stdout).agent_type).toBe("lane-stack:dev-orchestrator");
});

it("adapts the live empty-client guard deny through inject to hookSpecificOutput", () => {
  const inject = join(process.cwd(), "lane-stack/hooks/inject_agent_type.py");
  const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
  const result = spawnSync("python3", [inject, "--", "python3", guard], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/fixture/src/probe.ts" },
      cwd: "/fixture",
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator",
    },
  });
  expect(result.status).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(String(body.hookSpecificOutput.permissionDecisionReason)).toMatch(/orchestrator-guard/);
});

it("adapts empty-client deny JSON to native Claude PreToolUse hookSpecificOutput", () => {
  const inject = join(process.cwd(), "lane-stack/hooks/inject_agent_type.py");
  const deny = [
    "python3",
    "-c",
    "import json,sys; print(json.dumps({'decision':'deny','reason':'[orchestrator-guard] direct Write outside PM contract files is forbidden'})); sys.exit(0)",
  ];
  const result = spawnSync("python3", [inject, "--", ...deny], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      cwd: "/fixture",
    }),
    encoding: "utf8",
    env: { ...process.env, LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" },
  });
  expect(result.status).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.hookSpecificOutput).toEqual({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "[orchestrator-guard] direct Write outside PM contract files is forbidden",
  });
});
