/**
 * What a Codex session the plugin starts carries before the first word of its job (tool schemas, catalogs, instructions), and how the
 * plugin turns it down through Codex config keys alone (`config.toml` of a CODEX_HOME, or `-c key=value` of one `codex exec`).
 *
 * Every key below was checked on codex-cli 0.169.0 (`codex features list`, and `codex exec --strict-config -c <key>=...`, which refuses an
 * unknown key). A new Codex may rename or retire a flag: re-run `codex features list`, then `codex exec --strict-config` with this list.
 * Measured on the OVH hub, gpt-6-luna, effort low, one-line prompt (input tokens of the first request):
 *   writer home as Codex starts it today 16,267; with the owner's AGENTS.md left out and CODE_ROLE_OFF applied 8,098.
 *   judge: 5,856 with JUDGE_OFF_FEATURES and a short instructions file (default `codex exec` there: 13,846).
 */
export const CODEX_LEAN_CHECKED_ON = "0.169.0";

/** Feature flags no Lane Pilot role needs: Codex desktop/app surfaces, app and plugin catalogs, goals, tool suggestions. (Subagent tools go with `[agents] enabled = false`, set beside these; `features.multi_agent` is deprecated and only adds a warning.) */
export const CODEX_LEAN_COMMON_OFF: readonly string[] = [
  "apps", "plugins", "remote_plugin", "tool_suggest", "skill_mcp_dependency_install", "skill_search", "mentions_v2", "workspace_dependencies",
  "goals", "sleep_tool",
  "in_app_browser", "in_app_chat", "in_app_local_automation", "in_app_dictation", "in_app_voice", "in_app_updates",
];
/** The browser, computer and image tools of Codex itself (the plugin's browser checks and image work run through BB plugins, not these). */
export const CODEX_LEAN_SURFACE_OFF: readonly string[] = ["browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "image_generation"];

/**
 * `code`: writer, code-repair, night-fixer. Keeps the shell, exec sessions, apply_patch (not a flag) and view_image; drops the web.
 * `quiet`: critics, maintainers, one-shot readers. As `code`, and view_image too (they read files with the shell).
 * `open`: specialists, analysts, browser/errand roles, the lead. Keeps Codex's web search and its browser/computer/image tools.
 */
export type CodexLeanProfile = "code" | "quiet" | "open";
export const CODEX_LEAN_PROFILES: readonly CodexLeanProfile[] = ["code", "quiet", "open"];

export function codexLeanProfile(role: string): CodexLeanProfile {
  if (role === "writer" || role === "code-repair" || role === "night-fixer") return "code";
  if (role.startsWith("specialist:") || ["analyst", "planner", "auditor", "debugger", "browser-qa", "errand", "api-recon", "lead", "workflow-architect"].includes(role)) return "open";
  return "quiet";
}

/**
 * Which roles start their Codex session in a shared trimmed home (`codex.lean_roles`, read on the hub; a project row may override it).
 * `default` (and an unset value) is the list below: docs and the one-shot judges, whose measured jobs (the week to 2026-11-14) use the shell and
 * files only. `off` turns it off for every role (the escape hatch; so does the host env LANE_PILOT_CODEX_LEAN_HOME=off), `all` turns it on for
 * every role that has no strict worker home, otherwise a comma list of role ids in which `default` stands for the default list. Writers run in a
 * strict worker home where `worker.strict_user` is on; a writer outside it joins only when `writer` is listed (or `all`).
 */
export const CODEX_LEAN_DEFAULT_ROLES: readonly string[] = [
  "docs-maintainer", "plan-critic", "code-critic", "specialist-reviewer", "pm-reader", "gate-triage", "memory-maintainer", "project-life",
];
export type CodexLeanChoice = { mode: "off" } | { mode: "all" } | { mode: "roles"; roles: ReadonlySet<string> };

export function parseCodexLeanRoles(raw: unknown): CodexLeanChoice {
  const text = (Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : "").trim().toLowerCase();
  if (text === "off" || text === "false" || text === "none") return { mode: "off" };
  if (text === "all" || text === "on" || text === "true") return { mode: "all" };
  const names = text.split(/[\s,]+/).filter(Boolean);
  const roles = new Set<string>();
  for (const name of names.length ? names : ["default"]) {
    if (name === "default") CODEX_LEAN_DEFAULT_ROLES.forEach((role) => roles.add(role));
    else roles.add(name);
  }
  return { mode: "roles", roles };
}

/** Does this role start in a lean shared home? `envFlag` is the host's LANE_PILOT_CODEX_LEAN_HOME: `off` wins over the setting, `on` is the old «all roles» when the setting is unset. */
export function codexLeanEnabled(role: string, raw: unknown, envFlag?: string): boolean {
  if (envFlag === "off") return false;
  const choice = envFlag === "on" && (raw === undefined || raw === null || raw === "") ? ({ mode: "all" } as const) : parseCodexLeanRoles(raw);
  return choice.mode === "all" || (choice.mode === "roles" && choice.roles.has(role));
}

export function codexLeanOffFeatures(profile: CodexLeanProfile): string[] {
  return [...CODEX_LEAN_COMMON_OFF, ...(profile === "open" ? [] : CODEX_LEAN_SURFACE_OFF), ...(profile === "quiet" ? ["view_image"] : [])];
}

/** The memory judge's `codex/<model>` call: no tools at all (it answers one message), so the shell and every catalog go too. */
export const JUDGE_OFF_FEATURES: readonly string[] = [
  ...CODEX_LEAN_COMMON_OFF, ...CODEX_LEAN_SURFACE_OFF,
  "shell_tool", "unified_exec", "unified_exec_tty", "view_image", "hooks", "guardian_approval", "code_mode_host", "incremental_tools", "deferred_tool_world_state",
];

type Edit = { table: string; key: string; value: string };

const HEADER = /^\s*(\[\[?)\s*([^[\]]+?)\s*\]\]?\s*(#.*)?$/;

/**
 * Sets keys in a config.toml text and drops `[agents.<role>]` tables (their `config_file` paths are relative to the owner's home, and the
 * trimmed home has none). `table` "" is the top level. Other lines stay as they were; a key already set is replaced, a missing one added
 * at the top of its table (a missing table is appended). Idempotent.
 */
export function setTomlKeys(toml: string, edits: readonly Edit[], dropTablePrefix?: string): string {
  const lines = toml.split("\n");
  const blocks: Array<{ name: string; array: boolean; lines: string[] }> = [{ name: "", array: false, lines: [] }];
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header) blocks.push({ name: header[2]!, array: header[1] === "[[", lines: [line] });
    else blocks[blocks.length - 1]!.lines.push(line);
  }
  const kept = blocks.filter((block) => !(dropTablePrefix && block.name.startsWith(dropTablePrefix)));
  for (const edit of edits) {
    let block = kept.find((candidate) => candidate.name === edit.table && !candidate.array);
    const text = `${edit.key} = ${edit.value}`;
    if (!block) {
      block = { name: edit.table, array: false, lines: [`[${edit.table}]`, ""] };
      kept.push(block);
    }
    const own = new RegExp(`^\\s*${edit.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
    const at = block.lines.findIndex((line) => own.test(line));
    if (at >= 0) block.lines[at] = text;
    else block.lines.splice(block.name === "" ? 0 : 1, 0, text);
  }
  const out = kept.filter((block) => block.name !== "" || block.lines.some((line) => line.trim() !== "")).map((block) => block.lines.join("\n")).join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** The config.toml of a trimmed Codex home for one profile (the owner's file with the flags above set; web search off unless `open`). */
export function leanCodexConfig(toml: string, profile: CodexLeanProfile): string {
  const edits: Edit[] = [
    ...codexLeanOffFeatures(profile).map((key) => ({ table: "features", key, value: "false" })),
    { table: "agents", key: "enabled", value: "false" },
    ...(profile === "open" ? [] : [{ table: "", key: "web_search", value: '"disabled"' }]),
  ];
  return setTomlKeys(toml, edits, "agents.");
}
