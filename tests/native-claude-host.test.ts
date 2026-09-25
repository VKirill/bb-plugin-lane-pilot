import { chmod, mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { nativeLauncherScript } from "../src/native-claude-host";

it("exits 78 when session hooks are missing and does not exec claude", async () => {
  const dest = await mkdtemp(join(tmpdir(), "lp-native-launcher-"));
  const hooks = join(dest, "hooks");
  await mkdir(hooks, { recursive: true });
  const settingsPath = join(dest, "settings.json");
  const inject = join(hooks, "inject_agent_type.py");
  const guard = join(hooks, "guard_shell.py");
  const command = join(dest, "real-claude");
  await writeFile(settingsPath, "{}\n");
  await writeFile(inject, "# inject\n");
  await writeFile(guard, "# guard\n");
  await writeFile(command, "#!/bin/sh\necho launched\n");
  await chmod(command, 0o700);
  const launcher = join(dest, "claude");
  await writeFile(launcher, nativeLauncherScript({
    destDir: dest,
    command,
    settingsPath,
    agentId: "dev-orchestrator",
    settingId: "dev-orchestrator",
    extraArgs: [],
  }));
  await chmod(launcher, 0o700);
  expect(spawnSync(launcher, { encoding: "utf8" })).toMatchObject({ status: 0, stdout: "launched\n" });
  await unlink(inject);
  const missing = spawnSync(launcher, { encoding: "utf8" });
  expect(missing.status).toBe(78);
  expect(missing.stderr).toMatch(/native hooks missing/);
  expect(missing.stdout).toBe("");
});
