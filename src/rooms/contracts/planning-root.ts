import { homedir } from "node:os";
import type { RunCommandHost } from "@lane-pilot/host-calls";

/**
 * The project's second address (SMA m_pj_register, m_pj_planning, d_project_planning): `project.planning_home` names an
 * absolute folder on the project's host under which `.agents/phases`, `.agents/planning`, `.agents/todos` and the plan files of
 * `.agents/plans` live instead of the checkout's own `.agents`. Unset (or invalid) reads as the checkout — today's behaviour on
 * every install that sets nothing. Every reader and writer of those folders goes through this one resolver.
 *
 * NOT moved on purpose: `.agents/plans/items/<task>/` (a task's contract, check logs, checkpoint): the writer harness makes it inside
 * the writer's own git worktree and the merge excludes it (git-integrate TASK_FOLDER_EXCLUDE), so it cannot live in another repository.
 */
export const PLANNING_HOME_SETTING = "project.planning_home";

export type HomeCheck = {
  /** The home directory of the user running the hub (default: this process's). */
  userHome?: string;
  /** The checkouts of the OTHER Lane Pilot projects: a home may not sit inside one. */
  otherCheckouts?: readonly string[];
};
export type HomeLog = { warn(message: string): void };

const clean = (path: string): string => path.split("/").filter((part) => part !== "" && part !== ".").join("/");

/** Why a value cannot be a planning home, or null when it can (the checks that need no machine). */
export function planningHomeProblem(raw: string, check: HomeCheck = {}): string | null {
  const text = raw.trim();
  if (!text.startsWith("/")) return "the planning home must be an absolute path";
  if (text.includes("\0") || text.includes("\\")) return "the planning home must not contain a backslash or a NUL";
  if (text.split("/").includes("..")) return "the planning home must not contain «..»";
  const home = `/${clean(text)}`;
  if (home === "/") return "the planning home must not be the root folder";
  const user = check.userHome ?? safeHomedir();
  if (user && home === `/${clean(user)}`) return "the planning home must not be the home directory of the user";
  for (const checkout of check.otherCheckouts ?? []) {
    const other = `/${clean(checkout)}`;
    if (other !== "/" && (home === other || home.startsWith(`${other}/`))) return `the planning home lies inside the checkout of another project (${other})`;
  }
  return null;
}

function safeHomedir(): string | null { try { return homedir() || null; } catch { return null; } }

const warned = new Set<string>();
const warnOnce = (log: HomeLog | undefined, key: string, message: string) => { if (warned.has(key)) return; warned.add(key); log?.warn(message); };

/** The setting's value as a usable absolute path, or null. An invalid stored value reads as unset and is logged once. */
export function planningHomeOf(settings: Record<string, unknown> | null | undefined, check: HomeCheck = {}, log?: HomeLog): string | null {
  const raw = settings?.[PLANNING_HOME_SETTING];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const problem = planningHomeProblem(raw, check);
  if (problem) { warnOnce(log, `${raw}|${problem}`, `${PLANNING_HOME_SETTING} «${raw}» is ignored (${problem}); the checkout is the planning home`); return null; }
  return `/${clean(raw.trim())}`;
}

/** The root the `.agents/*` planning files are read and written under: the planning home when set, else the run's checkout. */
export function planningRoot(run: { writer_workspace_path?: string | null } | null | undefined, settings: Record<string, unknown> | null | undefined, check: HomeCheck = {}, log?: HomeLog): string | null {
  return planningHomeOf(settings, check, log) ?? run?.writer_workspace_path ?? null;
}

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
const confirmed = new Map<string, { ok: boolean; until: number }>();
/** Forgets what was confirmed (tests). */
export const resetPlanningHomeChecks = (): void => { confirmed.clear(); warned.clear(); };

/**
 * The machine-side half of the home's rules, asked on the project's host the first time a phase or the scanner uses the home:
 * it is a directory, it is not the user's home directory there, and it lies inside a git work tree (commits of planning files go to
 * that repository). A yes is remembered ten minutes, a no one minute; a no is logged once.
 */
export async function confirmPlanningHome(host: RunCommandHost, hostId: string, cwd: string, home: string, log?: HomeLog, now = Date.now()): Promise<boolean> {
  const key = `${hostId}\0${home}`;
  const known = confirmed.get(key);
  if (known && known.until > now) return known.ok;
  const h = quote(home);
  const command = `h=${h}; [ -d "$h" ] || { echo "not a directory"; exit 2; }; [ "$(cd "$h" && pwd -P)" != "$HOME" ] || { echo "it is the home directory of the user"; exit 3; }; [ "$(git -C "$h" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || { echo "it is not inside a git work tree"; exit 4; }`;
  let ok = false, why = "";
  try {
    const ran = await host.call("runCommand", { requestedHostId: hostId, command, cwd, timeoutSec: 20 }, { hostId, timeoutMs: 30_000 });
    ok = ran.exitCode === 0;
    why = (ran.stdout || ran.stderr).trim().split("\n")[0] ?? "";
  } catch (cause) { why = cause instanceof Error ? cause.message : String(cause); }
  confirmed.set(key, { ok, until: now + (ok ? 600_000 : 60_000) });
  if (!ok) warnOnce(log, `${key}|${why}`, `${PLANNING_HOME_SETTING} «${home}» is ignored on ${hostId}: ${why || "the check failed"}; the checkout is the planning home`);
  return ok;
}

/** Everything a caller has to hand over to resolve the home: the rest it takes from the project's settings. */
export type PlanningInputs = { settings: Record<string, unknown>; otherCheckouts: readonly string[] };

/**
 * The planning home of a project on its host, fully checked (settings rules and the host's), or null for "the checkout".
 * One resolver for the phase driver, the workflow executors, the backlog, the verdicts and the CLI verbs.
 */
export async function resolvePlanningHome(args: { host: RunCommandHost; hostId: string | null | undefined; cwd: string | null | undefined; inputs: PlanningInputs; log?: HomeLog }): Promise<string | null> {
  const home = planningHomeOf(args.inputs.settings, { otherCheckouts: args.inputs.otherCheckouts }, args.log);
  if (!home || !args.hostId || !args.cwd) return null;
  return (await confirmPlanningHome(args.host, args.hostId, args.cwd, home, args.log)) ? home : null;
}

/** The home as already confirmed on its host (no host call): for texts built where nothing can wait. Null until some caller has run `resolvePlanningHome`. */
export function confirmedPlanningHome(hostId: string | null | undefined, inputs: PlanningInputs): string | null {
  const home = planningHomeOf(inputs.settings, { otherCheckouts: inputs.otherCheckouts });
  return home && hostId && confirmed.get(`${hostId}\0${home}`)?.ok === true ? home : null;
}

/**
 * Text that names planning folders for a model (a stage rubric, a workflow prompt, an instruction to the PM): with a home set, every
 * `.agents/phases|planning|todos|plans` becomes the home's absolute folder; with none the text comes back untouched, byte for byte.
 * `.agents/plans/items/` (the writer's task folders) is not moved and keeps its path.
 */
export function planningText(text: string, home: string | null | undefined): string {
  if (!home) return text;
  return text.replace(/(?<![\w/.~-])\.agents\/(phases|planning|todos|plans)(?!\/items\b)(?![\w-])/g, (_all, dir: string) => `${home}/.agents/${dir}`);
}

/** Whether a project-relative path is a planning file the home holds (not `.agents/plans/items/`, the writer's task folders). */
export const isPlanningPath = (path: string): boolean => /^\.agents\/(phases|planning|todos|plans)\//.test(path) && !path.startsWith(".agents/plans/items/");
