import {
  SETTING_CATALOG,
  UNAPPLIED_REASON,
  unappliedNotValidReason,
  type CliBinary,
  type SettingSpec,
} from "./channels";
import { validateSettingsObject, validationErrorText } from "./setting-validation";

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

const FORBIDDEN_TOKENS = ["--apply", "setup"];

function appliesTo(spec: SettingSpec, binary: CliBinary, subcommand: string): boolean {
  if (spec.binaries && !spec.binaries.includes(binary)) return false;
  if (spec.subcommands && !spec.subcommands.includes(subcommand)) return false;
  return true;
}

function asFlagValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "" : null;
  return String(value);
}

export function isFlagOn(value: unknown): boolean {
  return value === true || value === "1" || value === "true" || value === "on";
}

export function isFlagOff(value: unknown): boolean {
  return value === false || value === "0" || value === "false" || value === "off" || value === "no";
}

function canonicalWriterSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const canonical = { ...settings };
  const tier = canonical["writer.service_tier"];
  const legacy = canonical["writer.fast_mode"];
  if ((tier === undefined || tier === null || tier === "") && (isFlagOn(legacy) || isFlagOff(legacy))) {
    canonical["writer.service_tier"] = isFlagOn(legacy) ? "fast" : "standard";
  }
  return canonical;
}

export function assertSafeArgv(argv: string[]): void {
  for (const token of argv) {
    if (FORBIDDEN_TOKENS.some((forbidden) => token === forbidden || token.startsWith(`${forbidden}=`))) {
      throw new Error(`refusing argv token ${token}: --apply/setup are forbidden in Mode 2`);
    }
  }
}

export function buildCliInvocation(input: {
  binary: CliBinary;
  subcommand: string;
  settings: Record<string, unknown>;
  required?: Record<string, string>;
}): CliInvocation {
  const settings = canonicalWriterSettings(input.settings);
  const argv = [input.subcommand];
  const env: Record<string, string> = {};
  const applied: string[] = [];
  const unapplied: UnappliedSetting[] = [];
  const usedFlags = new Set<string>();
  const validationErrors = validateSettingsObject(settings);
  const validationByKey = new Map(validationErrors.map((error) => [error.key, validationErrorText(error)]));

  for (const [flag, value] of Object.entries(input.required ?? {})) {
    const token = flag.startsWith("--") ? flag : `--${flag}`;
    if (value === "") argv.push(token);
    else argv.push(token, value);
    usedFlags.add(token);
  }

  const seen = new Set<string>();
  for (const spec of SETTING_CATALOG) {
    if (!(spec.key in settings)) continue;
    seen.add(spec.key);
    const value = settings[spec.key];
    const invalidSetting = validationByKey.get(spec.key);
    if (invalidSetting) {
      unapplied.push({ key: spec.key, value, channel: "NONE", reason: invalidSetting });
      continue;
    }
    if (spec.channel === "NONE") {
      unapplied.push({ key:spec.key, value, channel:"NONE", reason:spec.reason ?? UNAPPLIED_REASON.noChannel });
      continue;
    }
    if (spec.channel === "OWN") {
      unapplied.push({ key:spec.key, value, channel:"NONE", reason:spec.reason ?? "consumed by a native Lane Pilot stage; not an upstream CLI argument" });
      continue;
    }
    if (spec.channel === "INSTALL-ENV") {
      unapplied.push({ key:spec.key, value, channel:"NONE", reason: UNAPPLIED_REASON.installNotCli });
      continue;
    }
    if (!appliesTo(spec, input.binary, input.subcommand)) {
      unapplied.push({
        key:spec.key,
        value,
        channel:"NONE",
        reason: unappliedNotValidReason(spec, input.binary, input.subcommand),
      });
      continue;
    }
    if (spec.channel === "ENV-PASSTHROUGH" && spec.env) {
      if (typeof value === "boolean") {
        env[spec.env] = value ? "1" : "0";
        applied.push(spec.key);
        continue;
      }
      const text = asFlagValue(value);
      if (text !== null) {
        env[spec.env] = text;
        applied.push(spec.key);
      }
      continue;
    }
    if (!spec.flag) continue;
    if (usedFlags.has(spec.flag)) {
      applied.push(spec.key);
      continue;
    }
    if (spec.booleanFlag) {
      if (isFlagOn(value)) {
        argv.push(spec.flag);
        usedFlags.add(spec.flag);
        applied.push(spec.key);
        continue;
      }
      if (isFlagOff(value)) {
        if (spec.offFlag) {
          argv.push(spec.offFlag);
          usedFlags.add(spec.offFlag);
          applied.push(spec.key);
          continue;
        }
        unapplied.push({
          key: spec.key,
          value,
          channel: "NONE",
          reason: UNAPPLIED_REASON.booleanOffUnsupported,
        });
      }
      continue;
    }
    const text = asFlagValue(value);
    if (text === null) continue;
    argv.push(spec.flag, text);
    usedFlags.add(spec.flag);
    applied.push(spec.key);
  }

  for (const [key, value] of Object.entries(settings)) {
    if (seen.has(key)) continue;
    unapplied.push({ key, value, channel:"NONE", reason: UNAPPLIED_REASON.noConsumer });
  }

  assertSafeArgv(argv);
  return { argv, env, applied, unapplied };
}
