import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_OPS } from "../runs";

/** Phase names kept for the host context type. Lane Pilot does not instrument or run install.sh. (2026-10-29) */
export const INSTALL_PHASES = ["npm", "mkdir", "rsync", "settings", "install_json"] as const;
export type InstallPhase = (typeof INSTALL_PHASES)[number];

export const SKIP_WRAPPER_NAMES = ["npm", "npx", "open-cursor"] as const;

export function isolatedNpmPrefix(homeDir: string): string {
  return join(homeDir, ".agents/lane-pilot/npm-prefix");
}

export async function writeSkipWrappers(dir: string, skipLog: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of SKIP_WRAPPER_NAMES) {
    await writeFile(join(dir, name), `#!/bin/bash
printf '%s\\n' "blocked ${name} $*" >> ${JSON.stringify(skipLog)}
echo "lane-pilot: skipped ${name} (confirmExternalOps=false; real npm is never invoked)" >&2
exit 0
`, { mode: 0o755 });
    await chmod(join(dir, name), 0o755);
  }
}

const INSTALL_ENV_BY_KEY: Record<string, string> = {
  "install.LANE_INSTALL_LOCAL_MARKETPLACE": "LANE_INSTALL_LOCAL_MARKETPLACE",
  "install.LANE_INSTALL_CLAUDE_PLUGIN": "LANE_INSTALL_CLAUDE_PLUGIN",
  "install.CLAUDE_CONFIG_DIR": "CLAUDE_CONFIG_DIR",
  "install.CODEX_HOME": "CODEX_HOME",
};

function asEnvText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

export function applyInstallSettings(
  env: NodeJS.ProcessEnv,
  settings: Record<string, unknown> | undefined,
  _confirmExternalOps: boolean,
): string[] {
  const applied: string[] = [];
  if (!settings) return applied;
  for (const [key, name] of Object.entries(INSTALL_ENV_BY_KEY)) {
    if (!(key in settings)) continue;
    const text = asEnvText(settings[key]);
    if (text === null) continue;
    if (name === "LANE_INSTALL_CLAUDE_PLUGIN") continue;
    env[name] = text;
    applied.push(key);
  }
  return applied;
}

export function installEnv(input: {
  homeDir: string;
  confirmExternalOps: boolean;
  wrapperDir?: string;
  npmPrefix?: string;
  pathOverride?: string;
  executorPid?: number;
  stopAfterPhase?: InstallPhase;
  settings?: Record<string, unknown>;
}): { env: NodeJS.ProcessEnv; skippedExternalOps: string[]; applied: string[] } {
  const skipped = input.confirmExternalOps ? [] : [...EXTERNAL_OPS];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: input.homeDir,
    LANE_INSTALL_CLAUDE_PLUGIN: "0",
  };
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  if (input.executorPid) env.LANE_PILOT_EXECUTOR_PID = String(input.executorPid);
  if (input.stopAfterPhase) env.LANE_PILOT_STOP_AFTER = input.stopAfterPhase;
  if (!input.confirmExternalOps) {
    const prefix = input.npmPrefix ?? isolatedNpmPrefix(input.homeDir);
    env.npm_config_prefix = prefix;
    env.NPM_CONFIG_PREFIX = prefix;
    env.LANE_PILOT_SKIP_OPEN_CURSOR = "1";
    const rest = input.pathOverride ?? env.PATH ?? "/usr/bin:/bin";
    if (input.wrapperDir) {
      env.PATH = `${input.wrapperDir}:${rest}`;
    } else {
      env.PATH = rest;
    }
  }
  const applied = applyInstallSettings(env, input.settings, input.confirmExternalOps);
  return { env, skippedExternalOps: skipped, applied };
}
