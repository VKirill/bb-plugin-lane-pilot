import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { parse } from "jsonc-parser/lib/esm/main.js";
import { NATIVE_HOOK_SOURCES } from "../native-install";
import { hookCommandIdentity } from "@lane-pilot/kit";

function shellQuote(s: string) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export const BB_BRIDGE_MCP_SERVER = "bb-bridge";

export const NATIVE_LP_BRIDGE_TOOLS = [
  "lane_pilot_read",
  "lane_pilot_dispatch_writer",
  "lane_pilot_cancel_task",
  "lane_pilot_update_task",
  "lane_pilot_wait_writer",
  "lane_pilot_answer_writer",
  "lane_pilot_ask_owner",
  "lane_pilot_browser_qa",
  "lane_pilot_ingest_opencode_telemetry",
  "lane_pilot_memory_context",
  "lane_pilot_workspace_status",
  "lane_pilot_gate_report",
  "lane_pilot_handoff_create",
  "lane_pilot_handoff_receipt",
  "lane_pilot_handoff_list",
  "lane_pilot_routing_stats",
  "lane_pilot_lessons_sweep",
  "lane_pilot_rule_propose",
  "lane_pilot_lesson",
  "lane_pilot_learned",
  "lane_pilot_memory_golden",
  "lane_pilot_run_health",
  "lane_pilot_memory_import",
  "lane_pilot_memory_export",
  "lane_pilot_council_start",
  "lane_pilot_council_status",
  "lane_pilot_council_say",
  "lane_pilot_council_stop",
  "lane_pilot_specialist",
  "lane_pilot_wait_specialist",
  "lane_pilot_browser",
  "lane_pilot_errand",
  "lane_pilot_wait_errand",
  "lane_pilot_ask",
  "lane_pilot_reply",
  "lane_pilot_relay_list",
  "lane_pilot_workflow_draft_create",
  "lane_pilot_workflow_draft_patch",
  "lane_pilot_workflow_draft_get",
  "lane_pilot_workflow_capabilities",
  "lane_pilot_workflow_draft_test",
  "lane_pilot_workflow_draft_publish",
  "lane_pilot_route",
  "lane_pilot_run_workflow",
  "lane_pilot_workflow_status",
  "lane_pilot_workflow_amend",
  "lane_pilot_schedule",
  "lane_pilot_phase",
  "lane_pilot_queue",
  "lane_pilot_forge",
  "lane_pilot_facts",
  "lane_pilot_check",
  "lane_pilot_permit",
  "lane_pilot_helpers",
  "lane_pilot_council",
  "lane_pilot_relay",
  "lane_pilot_memory",
  "lane_pilot_workflow_draft",
  "lane_pilot_tool_search",
] as const;

/**
 * The PM's list is folded (src/pm-tool-families.ts): a compiled Claude Code profile holds at most 64 tools. The core tools keep their
 * names; the rest are actions of five family tools, plus lane_pilot_schedule and the search that finds a capability by words.
 */
export const NATIVE_LP_BRIDGE_PM_TOOLS = [
  "lane_pilot_read",
  "lane_pilot_dispatch_writer",
  "lane_pilot_wait_writer",
  "lane_pilot_answer_writer",
  "lane_pilot_cancel_task",
  "lane_pilot_update_task",
  "lane_pilot_reassign_task",
  "lane_pilot_workspace_status",
  "lane_pilot_run_health",
  "lane_pilot_ask_owner",
  "lane_pilot_errand",
  "lane_pilot_wait_errand",
  "lane_pilot_route",
  "lane_pilot_run_workflow",
  "lane_pilot_workflow_status",
  "lane_pilot_workflow_amend",
  "lane_pilot_helpers",
  "lane_pilot_council",
  "lane_pilot_relay",
  "lane_pilot_memory",
  "lane_pilot_workflow_draft",
  "lane_pilot_schedule",
  "lane_pilot_phase",
  "lane_pilot_queue",
  "lane_pilot_forge",
  "lane_pilot_facts",
  "lane_pilot_check",
  "lane_pilot_permit",
  "lane_pilot_tool_search",
] as const;

/** The one bridge tool a specialist gets: the schedule, so the owner can ask «every Monday collect…» in the specialist's own chat. */
export const NATIVE_LP_BRIDGE_SPECIALIST_TOOLS = ["lane_pilot_schedule"] as const;

/** The tools of the Workflow architect: it builds chains, it does not dispatch writers. */
export const NATIVE_LP_BRIDGE_ARCHITECT_TOOLS = [
  "lane_pilot_read",
  "lane_pilot_ask_owner",
  // The families the old per-action names were folded into (src/rooms/tools/pm-tool-families.ts): with the old names the architect had
  // only read and ask_owner and could build nothing (live architect order thr_ucanjpsgn5, 2026-10-25). Its session text is rewritten
  // to the family calls the same way as the PM's.
  "lane_pilot_workflow_draft",
  "lane_pilot_relay",
  "lane_pilot_tool_search",
] as const;

export function lpBridgeCatalogNames(tools: readonly string[] = NATIVE_LP_BRIDGE_TOOLS): string[] {
  return tools.map((name) => `mcp__${BB_BRIDGE_MCP_SERVER}__${name}`);
}

export function withoutLpBridgeTools(tools: readonly string[]): string[] {
  const prefix = `mcp__${BB_BRIDGE_MCP_SERVER}__`;
  return tools.filter((tool) => !tool.startsWith(prefix));
}

export function unionLpBridgeTools(
  tools: readonly string[],
  catalog: readonly string[] = NATIVE_LP_BRIDGE_PM_TOOLS,
): string[] {
  const extra = lpBridgeCatalogNames(catalog);
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

/** A PreToolUse hook as written: its group's matcher and every field of the handler (timeout ...), not only the command line. */
type HookEntry = { matcher: string; command: string; fields: Record<string, unknown> };

function hookEntries(settings: unknown): HookEntry[] {
  const hooks = asObject(asObject(settings)?.hooks);
  const entries = hooks?.PreToolUse;
  if (!Array.isArray(entries)) return [];
  const out: HookEntry[] = [];
  for (const entry of entries) {
    const group = asObject(entry) as HookGroup | null;
    if (!Array.isArray(group?.hooks)) continue;
    const matcher = typeof group.matcher === "string" && group.matcher ? group.matcher : "*";
    for (const item of group.hooks) {
      const row = asObject(item) as HookCommand | null;
      if (typeof row?.command === "string" && row.command.trim()) out.push({ matcher, command: row.command.trim(), fields: row as Record<string, unknown> });
    }
  }
  return out;
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

/**
 * Writes one of Lane Pilot's hook modules from the bundle (NATIVE_HOOK_SOURCES, equal to lane-stack/hooks). A lane-stack checkout
 * next to the host is not read: it can lag this repo's fixes (2026-10-09: the launcher ran the pinned claude-lane-stack guard, which
 * still refused the PM's thread stop). Every refresh overwrites the file, so a launcher written before a fix gets it on the next turn.
 */
async function writeBundledHook(name: keyof typeof NATIVE_HOOK_SOURCES, destDir: string): Promise<string> {
  const dest = join(destDir, name);
  const temp = `${dest}.${randomUUID()}`;
  try {
    await writeFile(temp, NATIVE_HOOK_SOURCES[name], { mode: 0o644 });
    await rename(temp, dest);
  } finally {
    await rm(temp, { force: true });
  }
  return dest;
}

export async function materializeNativeHookSession(input: {
  cwd?: string | null;
  destDir: string;
  /** No longer read: the hooks always come from the bundle. Kept so callers pass the same input. */
  moduleUrl?: string;
}): Promise<{ settingsPath: string; commands: string[] }> {
  const hooksDir = join(input.destDir, "hooks");
  await mkdir(hooksDir, { recursive: true, mode: 0o700 });
  const inject = await writeBundledHook("inject_agent_type.py", hooksDir);
  const guard = await writeBundledHook("guard_shell.py", hooksDir);
  await writeBundledHook("lib_payload.py", hooksDir);

  const cwd = input.cwd?.trim() && input.cwd.startsWith("/") ? input.cwd : null;
  const project = cwd ? await readSettingsFile(join(cwd, ".claude/settings.json")) : null;
  const local = cwd ? await readSettingsFile(join(cwd, ".claude/settings.local.json")) : null;
  // The same hook listed in both project and local settings (any quoting) under the same matcher must run once, not twice.
  const seenHooks = new Set<string>();
  const originals = [...hookEntries(project), ...hookEntries(local)].filter((entry) => {
    const identity = `${entry.matcher}\n${hookCommandIdentity(entry.command)}`;
    if (seenHooks.has(identity)) return false;
    seenHooks.add(identity);
    return true;
  });
  // Each hook keeps its matcher and timeout: a Bash-only check stays Bash-only (2026-10-29 audit: all of them ran on every tool).
  const groups = new Map<string, Array<Record<string, unknown>>>();
  const wrapped: string[] = [];
  let index = 0;
  for (const { matcher, command, fields } of originals) {
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
    const line = `python3 ${shellQuote(inject)} -- ${next}`;
    wrapped.push(line);
    groups.set(matcher, [...(groups.get(matcher) ?? []), { ...fields, type: "command", command: line }]);
  }
  // The guard watches every tool: a project guard hooked only under a narrower matcher does not stand in for it.
  if (!originals.some((entry) => entry.matcher === "*" && entry.command.includes("guard_shell.py"))) {
    const line = `python3 ${shellQuote(inject)} -- python3 ${shellQuote(guard)}`;
    wrapped.push(line);
    groups.set("*", [...(groups.get("*") ?? []), { type: "command", command: line }]);
  }

  const base = asObject(project) ?? {};
  const overlay = asObject(local) ?? {};
  const settings = {
    ...base,
    ...overlay,
    hooks: {
      ...(asObject(base.hooks) ?? {}),
      ...(asObject(overlay.hooks) ?? {}),
      PreToolUse: [...groups].map(([matcher, hooks]) => ({ matcher, hooks })),
    },
  };
  const settingsPath = join(input.destDir, "settings.json");
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { settingsPath, commands: wrapped };
}
