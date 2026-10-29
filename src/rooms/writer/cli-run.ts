import { join } from "node:path";
import { expandHomePath } from "@lane-pilot/kit";
import { spawnAsync } from "@lane-pilot/kit";

const FORBIDDEN = /(?:^|\s)(--apply(?:[= ]|$)|(?:^|\s)setup(?:\s|$))/;

// (2026-10-29) run-controller and lane-ctl are not called. This file stays for the host command path.

export async function runCommandOnHost(input: {
  requestedHostId: string;
  command: string;
  cwd: string;
  timeoutSec?: number;
}): Promise<{
  hostId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  if (FORBIDDEN.test(input.command) || input.command.includes("--apply") || /\bsetup\b/.test(input.command)) {
    throw new Error("refusing host command: --apply/setup are forbidden in Mode 2");
  }
  const result = await spawnAsync("/bin/bash", ["-lc", input.command], {
    cwd: input.cwd,
    timeout: (input.timeoutSec ?? 30) * 1000,
    // A dirty workspace snapshot runs to megabytes; the 1 MB default killed it with no message.
    maxBuffer: 64 * 1024 * 1024,
  });
  // A killed command has no status; say why instead of an empty stderr.
  const killed = [result.error?.message, result.signal ? `killed by ${result.signal}` : null].filter(Boolean).join("; ");
  return {
    hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: [result.stderr, killed].filter(Boolean).join("\n"),
  };
}

export async function writePmSettingsOnHost(input: {
  requestedHostId: string;
  pmWorkspacePath: string;
  homeDir?: string;
}): Promise<{ hostId:string; settingsPath:string; guardPath:string }> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const guardPath = expandHomePath("~/.agents/lane-pilot/pm/guard_shell.py", input.homeDir);
  const settingsPath = join(input.pmWorkspacePath, ".claude/settings.json");
  await mkdir(join(input.pmWorkspacePath, ".claude"), { recursive: true });
  const settings = {
    env: { LANE_PILOT_PM: "1" },
    hooks: {
      PreToolUse: [{
        matcher: "*",
        hooks: [{ type:"command", command:`python3 ${guardPath}` }],
      }],
    },
  };
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return {
    hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
    settingsPath,
    guardPath,
  };
}
