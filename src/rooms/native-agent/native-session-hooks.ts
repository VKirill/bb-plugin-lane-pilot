import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "jsonc-parser/lib/esm/main.js";
import { NATIVE_HOOK_SOURCES, SESSION_HOOK_SOURCE } from "../contracts/server";
import { hookCommandIdentity } from "@lane-pilot/kit";
import { shellQuote } from "@lane-pilot/contracts";
import { SUBAGENT_MATCHER } from "./models/bridge-tools";

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

/** Absolute, or `./…` under the project. A path that leaves the project is odd and is left uncopied. (2026-10-29 audit A-028) */
function hookModuleSource(token: string, projectCwd: string | null): string | null {
  if (isAbsolute(token)) return token;
  if (!projectCwd || !token.startsWith("./")) return null;
  const abs = resolve(projectCwd, token);
  const rel = relative(projectCwd, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
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

async function writeTextHook(dest: string, source: string): Promise<string> {
  const temp = `${dest}.${randomUUID()}`;
  try {
    await writeFile(temp, source, { mode: 0o644 });
    await rename(temp, dest);
  } finally {
    await rm(temp, { force: true });
  }
  return dest;
}

function hookGroups(settings: unknown, event: string): unknown[] {
  const list = asObject(asObject(settings)?.hooks)?.[event];
  return Array.isArray(list) ? list : [];
}

function uniqueGroups(groups: unknown[]): unknown[] {
  const seen = new Set<string>();
  return groups.filter((group) => {
    const key = JSON.stringify(group);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Session events the ported behaviour actually uses. Not Stop, and not every PreToolUse. SessionEnd writes the farewell draft (SMA k_hse_farewell). */
const SESSION_EVENTS = ["SessionStart", "UserPromptSubmit", "PreCompact", "SubagentStop", "PostToolUse", "SessionEnd"];

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
      const source = hookModuleSource(path, cwd);
      if (!source) continue;
      try {
        const copied = await copyBeside(source, hooksDir, `orig-${index}-${basename(source)}`);
        next = next.split(path).join(copied);
        index += 1;
      } catch {
        // (2026-10-29 audit A-028) a missing or unreadable hook stays as written; it must not reject the session.
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
  // Written from the bundle, like the guard: the host's dist has no cli.ts beside this module.
  // The subagent tool only: the pack inject. Stall is PostToolUse. Neither is a second process on every PreToolUse.
  // Claude Code names that tool Agent (Task before the rename) and a matcher is an exact name list, so both are listed:
  // under "Task" alone the spend cap, the pack and the subagent record never run for an Agent call.
  const sessionHook = await writeTextHook(join(hooksDir, "session-hook.mjs"), SESSION_HOOK_SOURCE);
  const sessionLine = `node ${shellQuote(sessionHook)}`;
  groups.set(SUBAGENT_MATCHER, [...(groups.get(SUBAGENT_MATCHER) ?? []), { type: "command", command: sessionLine }]);
  wrapped.push(sessionLine);

  const base = asObject(project) ?? {};
  const overlay = asObject(local) ?? {};
  const hooks: Record<string, unknown> = {
    ...(asObject(base.hooks) ?? {}),
    ...(asObject(overlay.hooks) ?? {}),
  };
  const seen = new Set<string>(["PreToolUse"]);
  for (const event of [...Object.keys(hooks), ...SESSION_EVENTS]) {
    if (seen.has(event)) continue;
    seen.add(event);
    if (!SESSION_EVENTS.includes(event) && !Array.isArray(hooks[event])) continue;
    const existing = [...hookGroups(project, event), ...hookGroups(local, event)].map((group) => {
      if (event !== "Stop" && event !== "SubagentStop") return group;
      const g = asObject(group);
      if (!g || !Array.isArray(g.hooks)) return group;
      return {
        ...g,
        hooks: g.hooks.map((item) => {
          const entry = asObject(item);
          if (!entry || entry.type !== "command" || typeof entry.command !== "string" || entry.command.includes("inject_agent_type.py")) return item;
          return { ...entry, command: `python3 ${shellQuote(inject)} -- ${entry.command}` };
        }),
      };
    });
    const ours = SESSION_EVENTS.includes(event)
      ? [{ matcher: "*", hooks: [{ type: "command", command: sessionLine }] }]
      : [];
    hooks[event] = uniqueGroups([...existing, ...ours]);
  }
  const settings = {
    ...base,
    ...overlay,
    hooks: {
      ...hooks,
      PreToolUse: [...groups].map(([matcher, hookList]) => ({ matcher, hooks: hookList })),
    },
  };
  const settingsPath = join(input.destDir, "settings.json");
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { settingsPath, commands: wrapped };
}
