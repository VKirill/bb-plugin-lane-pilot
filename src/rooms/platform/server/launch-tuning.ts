/**
 * Launch tuning: what a read-only helper is started with, per provider (VK core `launch-tuning`, plugin metadata key
 * `experimental_vkLaunchTuning`; a core without it stores the key and ignores it, so nothing changes there).
 *
 * Measured on this host (a shell write in each mode, permissions auto-allowed; core's VK_PATCHES.md has the table):
 *   Cursor `ask` and Devin `ask`: no write and no shell, Read and grep still work. Antigravity `plan`: answers a read-and-reply task
 *   directly and withholds `run_command` (an agent rule, not a sandbox), so `--sandbox` goes with it (workspace read-only for its terminal).
 *   Devin `plan` WRITES: never used. `DEVIN_SANDBOX` has no effect under `devin acp`: not used.
 *
 * Which roles: only those whose prompt says "read only" AND that need no shell and no scratch file. A critic that checks the packet against
 * the files reads them with the agent's own read tools; the code critic is left out of the ACP modes because its packet names `git log -p`
 * as the way to see a change that is already committed, and `ask` removes the shell. `auditor` and `triager` are graph agents whose
 * READ_ONLY_LINE lets them keep scratch files under .bb/chats or /tmp, so neither a mode nor a write ban fits them. Writers are never touched.
 */

/** Roles that read the project and answer; nothing they are told to do writes. */
const READ_ONLY_ROLES: ReadonlySet<string> = new Set(["plan-critic", "specialist-reviewer", "pm-reader", "gate-triage"]);

/** The roles Claude Code may also lose its edit tools for: the code critic keeps its Bash (git), only the file editors go. */
const NO_EDITOR_ROLES: ReadonlySet<string> = new Set([...READ_ONLY_ROLES, "code-critic"]);

type AcpTuning = { mode?: string; args?: string[] };

/** Provider id -> the narrowing the agent honours under ACP. */
const ACP_BY_PROVIDER: Readonly<Record<string, AcpTuning>> = {
  "acp-cursor": { mode: "ask" },
  devin: { mode: "ask" },
  "acp-antigravity": { mode: "plan", args: ["--sandbox"] },
};

/** Claude Code tools no read-only role ever calls. Unknown names are harmless, so MultiEdit stays for older installs. */
export const CLAUDE_EDITOR_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

export type LaunchTuning = { version: 1; acp?: AcpTuning; claude?: { disallowedTools: string[] } };

/** Escape hatch: `LANE_PILOT_LAUNCH_TUNING=off` on the hub starts every helper as before. */
export function launchTuningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no)$/i.test((env.LANE_PILOT_LAUNCH_TUNING ?? "").trim());
}

/** The tuning for one helper, or null: another role, another provider or the switch is off. Pure. */
export function launchTuningFor(providerId: string | undefined, role: string | null | undefined, env: NodeJS.ProcessEnv = process.env): LaunchTuning | null {
  if (!providerId || !role || !launchTuningEnabled(env)) return null;
  if (providerId === "claude-code") {
    return NO_EDITOR_ROLES.has(role) ? { version: 1, claude: { disallowedTools: [...CLAUDE_EDITOR_TOOLS] } } : null;
  }
  const acp = ACP_BY_PROVIDER[providerId];
  if (!acp || !READ_ONLY_ROLES.has(role)) return null;
  return { version: 1, acp: { ...(acp.mode ? { mode: acp.mode } : {}), ...(acp.args ? { args: [...acp.args] } : {}) } };
}

/** Adds the tuning to the spawn's plugin metadata. A caller that set its own `experimental_vkLaunchTuning` keeps it; everything else passes through untouched. */
export function withLaunchTuning<T extends { providerId?: string | undefined; pluginMetadata?: Record<string, unknown> | undefined }>(args: T, env: NodeJS.ProcessEnv = process.env): T {
  const meta = args.pluginMetadata;
  if (!meta || "experimental_vkLaunchTuning" in meta) return args;
  const tuning = launchTuningFor(args.providerId, typeof meta.role === "string" ? meta.role : null, env);
  return tuning ? { ...args, pluginMetadata: { ...meta, experimental_vkLaunchTuning: tuning } } : args;
}
