import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hookEnv } from "./hook-env";
import { NATIVE_HOOK_SOURCES } from "../src/rooms/native-install/native-hook-sources";
import { materializeNativeHookSession } from "../src/rooms/native-agent/native-session-hooks";

// A native PM launcher writes its hooks into native-launchers/<id>/hooks on every prepare. The hooks must be Lane Pilot's bundle,
// not a lane-stack checkout beside the host: that checkout can lag this repo's guard fixes (2026-10-09, the PM's thread stop refused).
const HOOKS = ["guard_shell.py", "inject_agent_type.py", "lib_payload.py"] as const;

async function hostWithStaleLaneStack(stale: string) {
  const root = await mkdtemp(join(tmpdir(), "lp-launcher-bundled-"));
  const stack = join(root, "lane-stack", "hooks");
  await mkdir(stack, { recursive: true });
  for (const name of HOOKS) await writeFile(join(stack, name), stale);
  const moduleUrl = pathToFileURL(join(root, "src", "rooms", "native-agent", "native-claude-host.ts")).href;
  return { root, moduleUrl, launcher: join(root, "native-launchers", "launcher-1") };
}

function runGuard(guard: string, command: string, agentType: string) {
  const payload = { agent_type: agentType, tool_name: "Bash", tool_input: { command }, cwd: process.cwd() };
  return spawnSync("python3", [guard], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
  });
}

describe("native launcher hooks come from Lane Pilot's bundle", () => {
  it("writes guard_shell.py, inject_agent_type.py and lib_payload.py byte-equal to the bundle, beside a different lane-stack copy", async () => {
    const { moduleUrl, launcher } = await hostWithStaleLaneStack("print('stale lane-stack guard')\n");
    const result = await materializeNativeHookSession({ destDir: launcher, moduleUrl });
    for (const name of HOOKS) {
      expect(await readFile(join(launcher, "hooks", name), "utf8"), name).toBe(NATIVE_HOOK_SOURCES[name]);
    }
    expect(result.commands.join("\n")).toContain(join(launcher, "hooks", "guard_shell.py"));
  });

  it("rewrites the hooks of an existing launcher whose guard is stale, and leaves no temp files", async () => {
    const { root, moduleUrl, launcher } = await hostWithStaleLaneStack("unused\n");
    await mkdir(join(launcher, "hooks"), { recursive: true });
    for (const name of HOOKS) await writeFile(join(launcher, "hooks", name), "print('launcher written before the fix')\n");
    await materializeNativeHookSession({ destDir: launcher, moduleUrl: pathToFileURL(join(root, "src", "x.ts")).href });
    for (const name of HOOKS) {
      expect(await readFile(join(launcher, "hooks", name), "utf8"), name).toBe(NATIVE_HOOK_SOURCES[name]);
    }
    expect((await readdir(join(launcher, "hooks"))).sort()).toEqual([...HOOKS].sort());
  });

  it("the rewritten launcher guard refuses a writer's thread control and lets the Lane Pilot PM stop a thread", async () => {
    const { moduleUrl, launcher } = await hostWithStaleLaneStack("print('stale lane-stack guard')\n");
    await materializeNativeHookSession({ destDir: launcher, moduleUrl });
    const guard = join(launcher, "hooks", "guard_shell.py");
    expect(runGuard(guard, "bb thread stop thr_abc", "lane-pilot-pm").status).toBe(0);
    expect(runGuard(guard, "bb thread new --prompt x", "lane-pilot-pm").status).toBe(2);
  });
});
