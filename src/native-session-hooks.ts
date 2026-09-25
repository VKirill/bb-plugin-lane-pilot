import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parse } from "jsonc-parser/lib/esm/main.js";
import { NATIVE_HOOK_SOURCES } from "./native-hook-sources";
import { defaultGuardSource } from "./paths";

function shellQuote(s: string) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export const BB_BRIDGE_MCP_SERVER = "bb-bridge";

export const NATIVE_LP_BRIDGE_TOOLS = [
  "lane_pilot_read",
  "lane_pilot_dispatch_writer",
  "lane_pilot_wait_writer",
  "lane_pilot_dispatch_cli",
  "lane_pilot_browser_qa",
  "lane_pilot_ingest_opencode_telemetry",
  "lane_pilot_docs_maintain",
  "lane_pilot_onboarding_preview",
  "lane_pilot_onboarding_apply",
  "lane_pilot_memory_maintain",
  "lane_pilot_memory_context",
  "lane_pilot_night_review",
  "lane_pilot_night_fix",
  "lane_pilot_workspace_status",
  "lane_pilot_gate_report",
  "lane_pilot_gate_triage",
] as const;

export function lpBridgeCatalogNames(tools: readonly string[] = NATIVE_LP_BRIDGE_TOOLS): string[] {
  return tools.map((name) => `mcp__${BB_BRIDGE_MCP_SERVER}__${name}`);
}

export function unionLpBridgeTools(tools: readonly string[]): string[] {
  const extra = lpBridgeCatalogNames();
  const seen = new Set(tools);
  const next = [...tools];
  for (const name of extra) {
    if (seen.has(name)) continue;
    seen.add(name);
    next.push(name);
  }
  return next;
}

type HookCommand = { type?: unknown; command?: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hookCommands(settings: unknown): string[] {
  const hooks = asObject(asObject(settings)?.hooks);
  const entries = hooks?.PreToolUse;
  if (!Array.isArray(entries)) return [];
  const commands: string[] = [];
  for (const entry of entries) {
    const group = asObject(entry) as HookGroup | null;
    if (!Array.isArray(group?.hooks)) continue;
    for (const item of group.hooks) {
      const row = asObject(item) as HookCommand | null;
      if (typeof row?.command === "string" && row.command.trim()) commands.push(row.command.trim());
    }
  }
  return commands;
}

async function readSettingsFile(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = parse(raw, [], { allowTrailingComma: true, disallowComments: false });
    return asObject(parsed) ?? {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function pythonPaths(command: string): string[] {
  return command.split(/\s+/).filter((part) => part.endsWith(".py") && (isAbsolute(part) || part.startsWith("./")));
}

async function copyBeside(source: string, destDir: string, name: string): Promise<string> {
  const dest = join(destDir, name);
  await cp(source, dest, { dereference: true });
  return dest;
}

async function materializePluginHook(
  name: keyof typeof NATIVE_HOOK_SOURCES,
  destDir: string,
  moduleUrl: string,
): Promise<string> {
  const dest = join(destDir, name);
  const source = join(dirname(defaultGuardSource(moduleUrl)), name);
  try {
    await cp(source, dest, { dereference: true });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    await writeFile(dest, NATIVE_HOOK_SOURCES[name], { mode: 0o644 });
  }
  return dest;
}

export async function materializeNativeHookSession(input: {
  cwd?: string | null;
  destDir: string;
  moduleUrl: string;
}): Promise<{ settingsPath: string; commands: string[] }> {
  const hooksDir = join(input.destDir, "hooks");
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const inject = await materializePluginHook("inject_agent_type.py", hooksDir, input.moduleUrl);
  const guard = await materializePluginHook("guard_shell.py", hooksDir, input.moduleUrl);
  await materializePluginHook("lib_payload.py", hooksDir, input.moduleUrl);

  const cwd = input.cwd?.trim() && input.cwd.startsWith("/") ? input.cwd : null;
  const project = cwd ? await readSettingsFile(join(cwd, ".claude/settings.json")) : null;
  const local = cwd ? await readSettingsFile(join(cwd, ".claude/settings.local.json")) : null;
  const originals = [...hookCommands(project), ...hookCommands(local)];
  const wrapped: string[] = [];
  let index = 0;
  for (const command of originals) {
    let next = command;
    for (const path of pythonPaths(command)) {
      try {
        const copied = await copyBeside(path, hooksDir, `orig-${index}-${basename(path)}`);
        next = next.split(path).join(copied);
        index += 1;
      } catch {
        throw new Error(`native hook module could not be copied: ${path}`);
      }
    }
    wrapped.push(`python3 ${shellQuote(inject)} -- ${next}`);
  }
  if (!originals.some((command) => command.includes("guard_shell.py"))) {
    wrapped.push(`python3 ${shellQuote(inject)} -- python3 ${shellQuote(guard)}`);
  }

  const base = asObject(project) ?? {};
  const overlay = asObject(local) ?? {};
  const settings = {
    ...base,
    ...overlay,
    hooks: {
      ...(asObject(base.hooks) ?? {}),
      ...(asObject(overlay.hooks) ?? {}),
      PreToolUse: [{ matcher: "*", hooks: wrapped.map((command) => ({ type: "command", command })) }],
    },
  };
  const settingsPath = join(input.destDir, "settings.json");
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { settingsPath, commands: wrapped };
}
