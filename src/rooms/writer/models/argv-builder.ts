import { WRITER_FAST_MODE_KEY, WRITER_SERVICE_TIER_KEY } from "../settings";
import {
  UNAPPLIED_REASON,
  type CliBinary,
  type SettingSpec,
} from "@lane-pilot/settings-catalog";

export type UnappliedSetting = {
  key: string;
  value: unknown;
  channel: "NONE";
  reason: string;
};

export type CliInvocation = {
  argv: string[];
  env: Record<string, string>;
  applied: string[];
  unapplied: UnappliedSetting[];
};

const INSTALL_ENV_KEYS = new Set([
  "install.LANE_INSTALL_LOCAL_MARKETPLACE",
  "install.LANE_INSTALL_CLAUDE_PLUGIN",
  "install.CLAUDE_CONFIG_DIR",
  "install.CODEX_HOME",
]);

const DEAD_LEGACY_KEYS = new Set([
  "ops.max_tasks",
  "ops.poll_interval",
  "ops.heartbeat_interval",
  "ops.retry_backoff",
  "ops.run_dir",
  "ops.project_cwd",
  "ops.task_id",
  "ops.task_file",
  "ops.idle",
  "ops.max_runtime",
  "ops.command_timeout",
  "ops.watch_timeout",
  "ops.tail_source",
  "ops.tail_lines",
  "ops.events_limit",
]);

// Forbidden flags (SMA): installers and the flags that switch a CLI's own permission checks off never reach a lane CLI.
const FORBIDDEN_TOKENS = ["--apply", "setup", "--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo"];

export function isFlagOn(value: unknown): boolean {
  return value === true || value === "1" || value === "true" || value === "on";
}

export function isFlagOff(value: unknown): boolean {
  return value === false || value === "0" || value === "false" || value === "off" || value === "no";
}

function canonicalWriterSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const canonical = { ...settings };
  const tier = canonical[WRITER_SERVICE_TIER_KEY];
  const legacy = canonical[WRITER_FAST_MODE_KEY];
  if ((tier === undefined || tier === null || tier === "") && (isFlagOn(legacy) || isFlagOff(legacy))) {
    canonical[WRITER_SERVICE_TIER_KEY] = isFlagOn(legacy) ? "fast" : "standard";
  }
  return canonical;
}

export function assertSafeArgv(argv: string[]): void {
  for (const token of argv) {
    if (FORBIDDEN_TOKENS.some((forbidden) => token === forbidden || token.startsWith(`${forbidden}=`))) {
      throw new Error(`refusing argv token ${token}: --apply, setup and permission-bypass flags are forbidden in Mode 2`);
    }
  }
}

export function buildCliInvocation(input: {
  binary: CliBinary;
  subcommand: string;
  settings: Record<string, unknown>;
  required?: Record<string, string>;
  /** Setting key -> why it cannot apply; the settings room's validator, injected so this file stays settings-free. */
  validate: (settings: Record<string, unknown>) => ReadonlyMap<string, string>;
  /** Optional predicate telling native keys apart from unconsumed legacy keys. */
  isNativeKey?: (key: string) => boolean;
  /** Optional explicit specs (retained for compatibility checks). */
  specs?: readonly SettingSpec[];
}): CliInvocation {
  const settings = canonicalWriterSettings(input.settings);
  const argv = [input.subcommand];
  const env: Record<string, string> = {};
  const applied: string[] = [];
  const unapplied: UnappliedSetting[] = [];
  const validationByKey = input.validate(settings);

  for (const [flag, value] of Object.entries(input.required ?? {})) {
    const token = flag.startsWith("--") ? flag : `--${flag}`;
    if (value === "") argv.push(token);
    else argv.push(token, value);
  }

  for (const [key, value] of Object.entries(settings)) {
    const invalidSetting = validationByKey.get(key);
    if (invalidSetting) {
      unapplied.push({ key, value, channel: "NONE", reason: invalidSetting });
      continue;
    }
    if (key === WRITER_FAST_MODE_KEY) {
      unapplied.push({ key, value, channel: "NONE", reason: UNAPPLIED_REASON.legacyFastModeMigrated });
      continue;
    }
    if (INSTALL_ENV_KEYS.has(key)) {
      unapplied.push({ key, value, channel: "NONE", reason: UNAPPLIED_REASON.installNotCli });
      continue;
    }
    if (DEAD_LEGACY_KEYS.has(key)) {
      unapplied.push({ key, value, channel: "NONE", reason: UNAPPLIED_REASON.noConsumer });
      continue;
    }
    const isNative = input.isNativeKey ? input.isNativeKey(key) : !key.startsWith("adoc.");
    if (isNative) {
      unapplied.push({ key, value, channel: "NONE", reason: "consumed by a native Lane Pilot stage; not an upstream CLI argument" });
      continue;
    }
    unapplied.push({ key, value, channel: "NONE", reason: UNAPPLIED_REASON.noConsumer });
  }

  assertSafeArgv(argv);
  return { argv, env, applied, unapplied };
}
