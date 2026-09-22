import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeArgv } from "./argv-builder";
import { agentsDir, expandHomePath, resolveHome } from "./paths";

const FORBIDDEN = /(?:^|\s)(--apply(?:[= ]|$)|(?:^|\s)setup(?:\s|$))/;

export async function resolveLaneBinary(
  binary: "run-controller" | "lane-ctl",
  homeDir?: string,
): Promise<string> {
  const home = resolveHome(homeDir);
  const candidates = [
    join(agentsDir(home), "bin", binary),
    join(home, ".local/bin", binary),
    binary,
  ];
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      /* try next */
    }
  }
  return binary;
}

export async function runCliOnHost(input: {
  requestedHostId: string;
  binary: "run-controller" | "lane-ctl";
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
  homeDir?: string;
}): Promise<{
  hostId: string;
  binaryPath: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  assertSafeArgv(input.argv);
  const binaryPath = await resolveLaneBinary(input.binary, input.homeDir);
  const result = spawnSync(binaryPath, input.argv, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    encoding: "utf8",
    timeout: input.timeoutMs ?? 120_000,
  });
  return {
    hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
    binaryPath,
    argv: input.argv,
    env: input.env,
    cwd: input.cwd,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

export function runCommandOnHost(input: {
  requestedHostId: string;
  command: string;
  cwd: string;
  timeoutSec?: number;
}): {
  hostId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  if (FORBIDDEN.test(input.command) || input.command.includes("--apply") || /\bsetup\b/.test(input.command)) {
    throw new Error("refusing host command: --apply/setup are forbidden in Mode 2");
  }
  const result = spawnSync("/bin/bash", ["-lc", input.command], {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: (input.timeoutSec ?? 30) * 1000,
  });
  return {
    hostId: process.env.BB_HOST_ID ?? input.requestedHostId,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
  };
}

export async function writePmSettingsOnHost(input: {
  requestedHostId: string;
  pmWorkspacePath: string;
  homeDir?: string;
}): Promise<{ hostId:string; settingsPath:string; guardPath:string }> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const guardPath = expandHomePath("~/.agents/hooks/guard_shell.py", input.homeDir);
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
