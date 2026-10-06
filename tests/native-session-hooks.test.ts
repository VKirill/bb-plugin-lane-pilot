import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { hookEnv } from "./hook-env";
import { NATIVE_HOOK_SOURCES } from "../src/native-hook-sources";
import { lpBridgeCatalogNames, materializeNativeHookSession, NATIVE_LP_BRIDGE_PM_TOOLS, NATIVE_LP_BRIDGE_TOOLS, unionLpBridgeTools } from "../src/native-session-hooks";

it("names only bb-bridge LP tools and does not invent a full allowlist", () => {
  const names = lpBridgeCatalogNames();
  expect(names).toEqual(NATIVE_LP_BRIDGE_TOOLS.map((name) => `mcp__bb-bridge__${name}`));
  expect(names).toContain("mcp__bb-bridge__lane_pilot_read");
  expect(names.some((name) => name === "Read" || name === "Write" || name === "Bash")).toBe(false);
});

it("unions LP bridge names onto an existing allowlist without a wildcard", () => {
  const next = unionLpBridgeTools(["Read", "Write", "Bash"]);
  expect(next.slice(0, 3)).toEqual(["Read", "Write", "Bash"]);
  expect(next.slice(3)).toEqual(lpBridgeCatalogNames(NATIVE_LP_BRIDGE_PM_TOOLS));
  expect(next).not.toContain("mcp__bb-bridge__lane_pilot_night_review");
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
  const env = hookEnv({ LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" });
  const filled = spawnSync("python3", [inject, "--", ...echo], {
    input: JSON.stringify({ tool_name: "Write" }),
    encoding: "utf8",
    env,
  });
  expect(JSON.parse(filled.stdout).agent_type).toBe("lane-stack:dev-orchestrator");
  const kept = spawnSync("python3", [inner, "--", ...echo], {
    input: JSON.stringify({ agent_type: "lane-stack:dev-orchestrator", tool_name: "Read" }),
    encoding: "utf8",
    env: hookEnv({ LANE_PILOT_AGENT_TYPE: "dev-orchestrator" }),
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
    env: hookEnv({
      LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator",
    }),
  });
  expect(result.status).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(String(body.hookSpecificOutput.permissionDecisionReason)).toMatch(/lane-pilot-guard.*lane_pilot_dispatch_writer/);
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
    env: hookEnv({ LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }),
  });
  expect(result.status).toBe(0);
  const body = JSON.parse(result.stdout);
  expect(body.hookSpecificOutput).toEqual({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "[orchestrator-guard] direct Write outside PM contract files is forbidden",
  });
});

it("lets the PM run bulk-reader and its other contract commands", () => {
  const inject = join(process.cwd(), "lane-stack/hooks/inject_agent_type.py");
  const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
  for (const command of [
    "pm_read --path fixture/tariffs.js --question 'premium tariff'",
    "/home/u/.agents/bin/pm_read --path fixture/tariffs.js --question 'x'",
    "plan-critique --run-dir /fixture/.agents/runs/demo",
    "check-owns-paths /fixture/.agents/runs/demo",
    "ls && cat README.md 2>/dev/null | head -80",
    "bb --version",
    "bb status",
    "bb thread show thr_abc",
    "bb uptime-monitor --help",
    "node scripts/collect-release-evidence.mjs migration --receipt /tmp/r.json",
    "sudo -n node --env-file=.env scripts/collect-release-evidence.mjs",
    "cd /home/ubuntu/apps/selfystudio && ./scripts/deploy.sh --base abc",
  ]) {
    const result = spawnSync("python3", [inject, "--", "python3", guard], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/fixture" }),
      encoding: "utf8",
      env: hookEnv({ LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }),
    });
    expect(result.stdout, command).not.toMatch(/deny/);
  }
});

it("keeps state-changing bb commands away from the PM", () => {
  const inject = join(process.cwd(), "lane-stack/hooks/inject_agent_type.py");
  const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
  for (const command of ["bb plugin build", "bb thread spawn --prompt x", "bb thread archive thr_abc"]) {
    const result = spawnSync("python3", [inject, "--", "python3", guard], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/fixture" }),
      encoding: "utf8",
      env: hookEnv({ LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }),
    });
    expect(result.stdout, command).toMatch(/deny/);
  }
});

it("sends a Lane PM in a BB chat to BB writer threads instead of CLI lanes", () => {
  const inject = join(process.cwd(), "lane-stack/hooks/inject_agent_type.py");
  const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
  const run = (command: string) => spawnSync("python3", [inject, "--", "python3", guard], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/fixture" }),
    encoding: "utf8",
    env: hookEnv({ LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }),
  }).stdout;
  for (const command of [
    "run-controller start --run-dir /fixture/.agents/runs/x --project-cwd /fixture",
    "lane-ctl start --task /fixture/.agents/runs/x/tasks/001.yaml",
    "/home/u/.agents/bin/lane-bg --dir /tmp/a -- sleep 1",
  ]) expect(run(command), command).toMatch(/lane_pilot_dispatch_writer/);
  expect(run("run-validate --run-dir /fixture/.agents/runs/x --phase pre-dispatch")).not.toMatch(/deny/);
});

it("passes unscoped and scoped SQL deletions through native session hook pipeline to guard", () => {
  const inject = join(process.cwd(), "lane-stack/hooks/inject_agent_type.py");
  const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
  const run = (command: string) => spawnSync("python3", [inject, "--", "python3", guard], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/fixture" }),
    encoding: "utf8",
    env: hookEnv({ LANE_PILOT_AGENT_TYPE: "writer" }),
  }).stdout;

  expect(run("sqlite3 db.sqlite 'delete from users; select 1;'")).toMatch(/DELETE without WHERE blocked/);
  expect(run("sqlite3 db.sqlite 'delete from users where id = 1;'")).not.toMatch(/deny/);
});

