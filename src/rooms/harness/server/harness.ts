import { runOnHost } from "@lane-pilot/host-calls";
import { writerExecutionSelection } from "@lane-pilot/models";
import { upsertLessonProposal, type RuleForm } from "@lane-pilot/run-insights";
import {
  HarnessValidationError, LANE_PILOT_SURFACE, PROBE_DEFAULTS, alwaysOnText, checkNames, composePrompt, experienceIsSupported, experiencePrompt, fingerprint, inventory, isBase, missionPointer,
  parseEdits, parseExperience, parseNotes, proposePrompt, renderExperienceMarkdown, renderThreadEvents, screenRejected, skillNames, validate,
  type ProbeBudget, type RejectedEdit, type ThreadEventLike, type Tree,
} from "@lane-pilot/harness-core";
import { fullAccessSpawn, scheduleIsolated, stringAt, type ServerCore, type Services } from "../../core/server";
import { SANDBOX_PROJECT_ID, isSandboxProjectName } from "../../stability/server";
import { ensureExcludeLinesCommand, EXCLUDE_NOT_GIT } from "../../verification";
import { getAttempt, getTaskGitBase } from "../../storage";
import { hubFields } from "../../improvement";
import { evidenceFiles, evidenceLayout, harvestCommand, parseHarvest, shellQuote, sliceAttemptEvents, treeDiff, writeFileCommands, type AttemptEvidence, type LibraryEntry, type PoolCandidate } from "./evidence";
import {
  ANY_WRITER, activeHarness, assignAttemptHarness, getHarness, insertHarness, listExperiences, listHarnesses, saveExperience, setHarnessState, teachingKeys, trialAttempts, trialHarness,
  type HarnessRow,
} from "./store";
import { TRIAL_DEFAULTS, decideTrial, type AdoptBy, type TrialConfig, type TrialDecision } from "./trial";
import { getBenchProject, verdictForHarness } from "../../bench";
import type { HostPort } from "../../bench/server";
import { graphEditProblems } from "./graph-edit";
import { formatProbeReplays, runHarnessProbe } from "./probe-run";
import { builtinWorkflow } from "../../workflow";
import type { StepContext } from "../../workflow";
import type { ChainRuntime, GraphHelperRun } from "../../workflow/server";

/** The graphs that run the model work of the harness: an improvement round for a key (prepare, edit, validate) and the reflection on a decided trial. */
export const HARNESS_EDIT_WORKFLOW = "lp.harness-edit";
export const HARNESS_REFLECT_WORKFLOW = "lp.harness-reflect";
/** Runs one helper thread of a graph step (workflow/server's `runGraphHelper` bound to the step); passed in so this room does not import the workflow room's server. */
export type GraphHelperFn = (input: { key: string; spawn: (graph: { spawnId: string; metadata: Record<string, unknown> }) => Promise<string>; waitMs?: number; label: string; projectId: string | null; archive?: boolean }) => Promise<GraphHelperRun>;
export type HarnessStep = { c: StepContext<ChainRuntime>; helper: GraphHelperFn; runs: GraphHelperRun[] };

/**
 * The writer harness that learns (the Harness² port, phases 1–5). Per (project, area, writer model) one tree is active:
 * the base (empty) or an adopted one. At night an editor thread reads the area's recent attempts and proposes a
 * candidate tree; the candidate goes on trial on the area's next tasks in alternation with the active tree; the trial
 * adopts or retires it on the attempts' own outcomes; a reflection thread then writes what each edit did and at most
 * one lesson, which enters the rules pipeline with its form. Nothing a writer gets today is taken away: the tree adds.
 */
export type HarnessConfig = {
  enabled: boolean;
  /** Attempts a key needs in the window before an editor is spent on it. */
  minAttempts: number;
  windowDays: number;
  /** Keys one night may start an editor for, per project; an editor is three Opus sessions. */
  maxKeysPerNight: number;
  /** Attempts the editor reads, newest first. */
  attemptsPerEvidence: number;
  editor: ModelSelection;
  /** A role's own model when it differs from `editor`: the two editors, the composer and the reflection can spread the spend. */
  roles: Partial<Record<HarnessRole, ModelSelection | null>>;
  waitMinutes: number;
  trial: TrialConfig;
  /** `harness.adopt_by` (SMA plan P0-1): `bench` (default) adopts a tree only after a passed bench comparison; `live` keeps the alternation as the judge. */
  adoptBy: AdoptBy;
  /** Propose–Probe–Compose: saved attempts replayed before the composer, and the token cap for that round. `tokenBudget` 0 skips it. */
  probe: ProbeBudget;
  /** When true, an editor may change workflows/<name>.json. The file still goes through the same trial and bench gate. Off by default. */
  graphEdits: boolean;
  /** An area is taught only when its attempts in the window span at least this many days (≥5 attempts in one afternoon repeat nothing). */
  minSpanDays: number;
};

export type ModelSelection = { providerId: string; model: string; reasoningLevel: string };
export type HarnessRole = "inv" | "dom" | "compose" | "reflect";
export const HARNESS_ROLES: readonly HarnessRole[] = ["inv", "dom", "compose", "reflect"];

/** The model a role runs on: its own selection when complete, else the editor's. */
export function roleSelection(cfg: Pick<HarnessConfig, "editor" | "roles">, role: HarnessRole): ModelSelection {
  const own = cfg.roles?.[role];
  return own && own.providerId && own.model ? { ...own, reasoningLevel: own.reasoningLevel || cfg.editor.reasoningLevel } : cfg.editor;
}

export const HARNESS_DEFAULTS: HarnessConfig = {
  enabled: true, minAttempts: 5, windowDays: 7, maxKeysPerNight: 2, attemptsPerEvidence: 8,
  // Owner's choice 2026-10-19: the editors run on Gemini 3.8 Flash (high) through OpenCode's Antigravity route
  // (`router9/ag/gemini-3.8-flash-high`; the «high» is in the name, the effort stays the catalog default «medium»),
  // not on Opus: three sessions a key a night must stay cheap, and the trial, not the editor, decides what ships.
  editor: { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoningLevel: "medium" }, roles: {}, waitMinutes: 40, trial: TRIAL_DEFAULTS, adoptBy: "bench", minSpanDays: 3,
  probe: PROBE_DEFAULTS, graphEdits: false,
};

const CONFIG_KEY = (projectId: string) => `harness:config:${projectId}`;
const LAST_EDIT_KEY = (projectId: string, area: string, writerKey: string) => `harness:last-edit:${projectId}:${area}:${writerKey}`;
export const HARNESS_DIR = ".lane-pilot/harness";
const EXCLUDE_LINES = [".lane-pilot/", ".opencode/skills/", ".claude/skills/"];
const EVENT_PAGE = 100;
const EVENT_PAGES_MAX = 60;
const TRAJECTORY_MAX_CHARS = 120_000;
/** The second editor of a round starts this much later than the first (OpenCode startup holds its database). */
const EDITOR_STAGGER_MS = 15_000;
/** The waits of a round, in one place so a test can shorten them: the second editor starts later, and a session that ended early is retried after a pause. */
export const HARNESS_TUNING = { editorStaggerMs: EDITOR_STAGGER_MS, retryDelayMs: 20_000 };

export type BriefParts = { harnessId: string; arm: "new" | "old" | null; alwaysOn: string; memory: string; skillNames: string[]; checkNames: string[]; tree: Tree };

const slug = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "project";

export function briefParts(row: Pick<HarnessRow, "id" | "tree">, arm: "new" | "old" | null): BriefParts {
  const tree = row.tree;
  const memory = (tree[LANE_PILOT_SURFACE.memoryFile] ?? "").split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).map((line) => line.trim()).join("\n");
  return { harnessId: row.id, arm, alwaysOn: alwaysOnText(tree).trim(), memory, skillNames: skillNames(tree), checkNames: checkNames(tree), tree };
}

/** Verification commands a tree adds to an attempt: its checks, run from the worktree where they were materialized. */
export function checkCommands(tree: Tree): Array<{ command: string; timeout_sec: number }> {
  return checkNames(tree).map((rel) => {
    const runner = rel.endsWith(".py") ? "python3" : rel.endsWith(".mjs") ? "node" : "bash";
    return { command: `${runner} ${HARNESS_DIR}/${rel}`, timeout_sec: 60 };
  });
}

/** The lesson's form from the component it names; the rules UI and the writer brief route on it. */
/** The settings file a Claude Code writer reads its hooks from: the tree's hooks.json as written, under the one `hooks` key. */
export function hooksSettings(hooksJson: string): string {
  try {
    const parsed = JSON.parse(hooksJson) as { hooks?: unknown };
    return JSON.stringify({ hooks: parsed.hooks ?? {} }, null, 2);
  } catch { return JSON.stringify({ hooks: {} }); }
}

export function inferForm(lesson: string): RuleForm {
  const text = lesson.toLowerCase();
  if (/\bchecks?\b|verification|\.sh\b|\.py\b|\.mjs\b/.test(text)) return "check";
  if (/\bskill\b/.test(text)) return "skill";
  if (/\bhooks?\b/.test(text)) return "hook";
  if (/\bmemory\b|memory\.md|\bnote\b/.test(text)) return "memory";
  return "always";
}

type StageResult = { tree: Tree; keptBase: boolean; notes: string; threadIds: string[]; error: string | null };
type StageSession = { threadId: string | null; text: string; tree: Tree | null; error: string | null };

/** How long a stage waits before its second session: OpenCode's startup holds its database for a few seconds. */
export const SESSION_RETRY_DELAY_MS = 20_000;

/**
 * A session that ended with BB's own verdict (a refused turn, an agent that did not start) rather than at the deadline.
 * Such an end is usually one-off: on 2026-10-19 the INV editor of BB-сервис feature:shell got «Agent stopped the turn:
 * refusal» from Gemini after reading the evidence, and the DOM editor, spawned two seconds later on the same Mac,
 * died on «Command thread.start failed … database is locked» while the first OpenCode process was starting. A session
 * that ran out of time is not tried again: a second one would cost another full wait.
 */
export function sessionEndedEarly(error: string | null): boolean {
  return !!error && !/:incomplete:/.test(error);
}

/**
 * The stage loop, the way Harness² does it: a rejected tree goes back with the error verbatim (one retry); a session that
 * ended early gets one more session in the same folder; everything else keeps the fallback with the error.
 */
export async function runStage(input: { mission: string; fallback: Tree; title: string; surface?: typeof LANE_PILOT_SURFACE }, run: (mission: string) => Promise<StageSession>,
  log: (line: string) => void, retryDelayMs = SESSION_RETRY_DELAY_MS): Promise<StageResult> {
  const threadIds: string[] = [];
  let mission = input.mission;
  let lastError: string | null = null;
  let rejected = 0, restarted = 0;
  while (true) {
    const result = await run(mission);
    if (result.threadId) threadIds.push(result.threadId);
    if (result.error && sessionEndedEarly(result.error) && restarted === 0) {
      restarted++;
      // «ended early», not «failed»: the watcher reads failure lines of this log as incidents, and this one is handled.
      log(`harness session «${input.title}» ended early, starting one more session: ${result.error}`);
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      mission = `${mission}\n\n# A PREVIOUS SESSION IN THIS FOLDER STOPPED EARLY\n\nIt ended with: ${result.error.slice(0, 300)}\n\n\`context/harness/\` may hold its partial edits: check them before you build on them, then do the whole job and reply.`;
      continue;
    }
    if (result.error || !result.tree) { lastError = result.error ?? "no tree came back"; break; }
    const { notes, keepBase } = parseNotes(result.text);
    const tree = result.tree;
    try {
      validate(tree, input.surface ? { surface: input.surface } : {});
      if (input.surface?.graphFiles) {
        const graphProblems = graphEditProblems(tree);
        if (graphProblems.length) throw new HarnessValidationError(graphProblems);
      }
    } catch (cause) {
      lastError = cause instanceof HarnessValidationError ? cause.message : String(cause);
      if (++rejected >= 2) break;
      mission = `${input.mission}\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${lastError}\n\nFix it in \`context/harness/\` (the files are still there) and reply again.`;
      continue;
    }
    return { tree, keptBase: keepBase || isBase(input.fallback, tree), notes, threadIds, error: null };
  }
  return { tree: input.fallback, keptBase: true, notes: "", threadIds, error: lastError };
}

export function createHarness(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;
  const running = new Set<string>();

  /** Retired trees of this key, with the reason they were refused. The editor reads them; an identical fingerprint is not trialled again. */
  function rejectedFor(projectId: string, area: string, writerKey: string): RejectedEdit[] {
    return listHarnesses(db, projectId, { area, writerKey, states: ["retired"] })
      .filter((row) => row.reason?.trim())
      .map((row) => ({ fingerprint: row.fingerprint, reason: row.reason!.trim(), summary: inventory(row.tree) }));
  }

  async function config(projectId: string): Promise<HarnessConfig> {
    const raw = await bb.storage.kv.get(CONFIG_KEY(projectId)).catch(() => null) as Partial<HarnessConfig> | null;
    // `harness.adopt_by` of the global level is the default of every project; a project's own record still wins.
    const hub = hubFields(db, "harness") as { adoptBy?: AdoptBy };
    return { ...HARNESS_DEFAULTS, ...(hub.adoptBy ? { adoptBy: hub.adoptBy } : {}), ...(raw ?? {}), editor: { ...HARNESS_DEFAULTS.editor, ...(raw?.editor ?? {}) }, roles: { ...(raw?.roles ?? {}) }, trial: { ...TRIAL_DEFAULTS, ...(raw?.trial ?? {}) }, probe: { ...PROBE_DEFAULTS, ...(raw?.probe ?? {}) } };
  }

  /** A patch merges a level deep; a role set to null goes back to the editor's model. */
  async function setConfig(projectId: string, patch: Partial<HarnessConfig>): Promise<HarnessConfig> {
    const current = await config(projectId);
    const roles = { ...current.roles };
    for (const [role, value] of Object.entries(patch.roles ?? {})) {
      if (!HARNESS_ROLES.includes(role as HarnessRole)) continue;
      if (value === null) delete roles[role as HarnessRole]; else roles[role as HarnessRole] = { ...(roles[role as HarnessRole] ?? current.editor), ...value };
    }
    const next: HarnessConfig = { ...current, ...patch, editor: { ...current.editor, ...(patch.editor ?? {}) }, roles, trial: { ...current.trial, ...(patch.trial ?? {}) }, probe: { ...current.probe, ...(patch.probe ?? {}) } };
    // The resolved default stays out of the project's record unless the project set it, so a later change of the global default reaches it.
    const stored = await bb.storage.kv.get(CONFIG_KEY(projectId)).catch(() => null) as Partial<HarnessConfig> | null;
    const keepAdopt = patch.adoptBy !== undefined || stored?.adoptBy !== undefined;
    const { adoptBy: _resolved, ...withoutAdopt } = next;
    await bb.storage.kv.set(CONFIG_KEY(projectId), (keepAdopt ? next : withoutAdopt) as never);
    return next;
  }

  /**
   * The tree an attempt runs under. With a trial open for the key the arms alternate by the order attempts are assigned,
   * so both arms see the same stream of tasks; without one the active tree (adopted or base) is recorded with no arm.
   */
  async function forAttempt(input: { projectId: string; area: string | null | undefined; writerKey: string; attemptId: string }): Promise<BriefParts | null> {
    // A bench sandbox project runs under the tree its arm names (none, the source project's active tree, or one tree id), never under live alternation.
    const bench = getBenchProject(db, input.projectId);
    if (bench) return forBenchAttempt(bench, input);
    const cfg = await config(input.projectId);
    if (!cfg.enabled) return null;
    const area = (input.area ?? "").trim();
    const keys = [input.writerKey, ANY_WRITER];
    for (const writerKey of keys) {
      const trial = trialHarness(db, input.projectId, area, writerKey);
      if (trial) {
        const active = activeHarness(db, input.projectId, area, writerKey);
        const assigned = db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt WHERE harness_arm IN ('new','old') AND created_at>=? AND harness_tree_id IN (?,?)")
          .get(trial.trialStartedAt ?? 0, trial.id, active.id) as { n: number };
        const arm: "new" | "old" = assigned.n % 2 === 0 ? "new" : "old";
        const chosen = arm === "new" ? trial : active;
        assignAttemptHarness(db, input.attemptId, chosen.id, arm);
        return briefParts(chosen, arm);
      }
    }
    const own = listHarnesses(db, input.projectId, { area, writerKey: input.writerKey, states: ["adopted"] })[0];
    const any = own ? null : listHarnesses(db, input.projectId, { area, writerKey: ANY_WRITER, states: ["adopted"] })[0];
    const active = own ?? any ?? activeHarness(db, input.projectId, area, input.writerKey);
    assignAttemptHarness(db, input.attemptId, active.id, null);
    return briefParts(active, null);
  }

  /** The tree a bench arm names: `none` gives the writer no tree, `tree` the source project's adopted or base tree for the task's area, anything else is a tree id. */
  function forBenchAttempt(bench: NonNullable<ReturnType<typeof getBenchProject>>, input: { projectId: string; area: string | null | undefined; writerKey: string; attemptId: string }): BriefParts | null {
    if (bench.harness === "none") return null;
    // The bench gives every task an area of its own (`<area>~b<position><arm>r<n>`); the tree belongs to the original area.
    const area = (input.area ?? "").trim().replace(/~b\d+[a-z0-9-]*r\d+$/, "");
    if (bench.harness === "tree") {
      const sourceId = bench.sourceProjectId ?? input.projectId;
      const own = listHarnesses(db, sourceId, { area, writerKey: input.writerKey, states: ["adopted"] })[0];
      const any = own ? null : listHarnesses(db, sourceId, { area, writerKey: ANY_WRITER, states: ["adopted"] })[0];
      const chosen = own ?? any ?? activeHarness(db, sourceId, area, input.writerKey);
      assignAttemptHarness(db, input.attemptId, chosen.id, null);
      return briefParts(chosen, null);
    }
    const tree = getHarness(db, bench.harness);
    if (!tree) return null;
    assignAttemptHarness(db, input.attemptId, tree.id, null);
    return briefParts(tree, null);
  }

  /** Writes a tree's skills and checks into the worktree (git-excluded) and links the skills where the writer's runtime looks. */
  async function materialize(input: { attemptId: string; hostId: string; workspacePath: string; live: boolean; providerId?: string; parts: BriefParts }): Promise<{ written: string[]; reason: string | null }> {
    const { tree } = input.parts;
    const files = Object.fromEntries(Object.entries(tree).filter(([rel]) => rel.startsWith(`${LANE_PILOT_SURFACE.skillDir}/`) || rel.startsWith(`${LANE_PILOT_SURFACE.checksDir}/`)));
    if (Object.keys(files).length === 0 && !(LANE_PILOT_SURFACE.hooksFile in tree)) return { written: [], reason: null };
    if (input.live) return { written: [], reason: "live_folder" };
    const excluded = await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: ensureExcludeLinesCommand(EXCLUDE_LINES), timeoutSec: 30 })
      .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), hostId: input.hostId }));
    if (excluded.exitCode !== 0 || excluded.stdout.includes(EXCLUDE_NOT_GIT)) return { written: [], reason: excluded.exitCode !== 0 ? "exclude_failed" : "not_git" };
    for (const command of writeFileCommands(HARNESS_DIR, files)) {
      const wrote = await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command, timeoutSec: 60 })
        .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause), hostId: input.hostId }));
      if (wrote.exitCode !== 0 || !wrote.stdout.includes("@@WRITTEN")) {
        ctx.log(`harness ${input.attemptId}: tree not materialized: ${wrote.stderr.trim() || `exit ${wrote.exitCode}`}`);
        return { written: [], reason: "write_failed" };
      }
    }
    const links = input.parts.skillNames.flatMap((name) => [".opencode/skills", ".claude/skills"].map((dir) =>
      `mkdir -p ${shellQuote(dir)} && ln -sfn ${shellQuote(`../../${HARNESS_DIR}/skills/${name}`)} ${shellQuote(`${dir}/${name}`)}`));
    const chmod = input.parts.checkNames.map((rel) => `chmod +x ${shellQuote(`${HARNESS_DIR}/${rel}`)}`);
    // hooks.json fires only where the writer's runtime reads Claude Code hooks: a Claude Code writer gets it as the
    // worktree's .claude/settings.local.json (git-excluded); other runtimes ignore the file, as the surface table says.
    const hooks = tree[LANE_PILOT_SURFACE.hooksFile];
    const hookLines = hooks && input.providerId === "claude-code" ? [`mkdir -p .claude && printf '%s' ${shellQuote(hooksSettings(hooks))} > .claude/settings.local.json`] : [];
    if (links.length || chmod.length || hookLines.length) await runOnHost(host, { hostId: input.hostId, cwd: input.workspacePath, command: [...links, ...chmod, ...hookLines, "true"].join("\n"), timeoutSec: 30 }).catch(() => undefined);
    return { written: [...Object.keys(files), ...(hookLines.length ? [LANE_PILOT_SURFACE.hooksFile] : [])], reason: null };
  }

  /** The checks the attempt's tree adds to its verification; empty for an attempt without a tree or with a live folder. */
  function checksForAttempt(attemptId: string): Array<{ command: string; timeout_sec: number }> {
    const attempt = db.prepare("SELECT harness_tree_id AS id FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { id: string | null } | undefined;
    if (!attempt?.id) return [];
    const row = getHarness(db, attempt.id);
    return row ? checkCommands(row.tree) : [];
  }

  function checksForWriterThread(runId: string, taskId: string, writerThreadId: string): Array<{ command: string; timeout_sec: number }> {
    const attempt = db.prepare("SELECT id FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND thread_id=? ORDER BY created_at DESC LIMIT 1").get(runId, taskId, writerThreadId) as { id: string } | undefined;
    return attempt ? checksForAttempt(attempt.id) : [];
  }

  /** Every event of a thread, oldest first; a failure is logged once and gives what was read so far. */
  async function listThreadEvents(threadId: string): Promise<unknown[]> {
    const events: unknown[] = [];
    let cursor = 0;
    for (let pages = 0; pages < EVENT_PAGES_MAX; pages++) {
      let listed: unknown;
      try {
        listed = await bb.sdk.threads.events.list({ threadId, order: "asc", limit: String(EVENT_PAGE), ...(cursor > 0 ? { afterSeq: String(cursor) } : {}) } as never);
      } catch (cause) {
        ctx.log(`harness: events of ${threadId} could not be read after ${events.length}: ${cause instanceof Error ? cause.message : String(cause)}`);
        break;
      }
      if (!Array.isArray(listed)) { ctx.log(`harness: events of ${threadId} came back as ${listed === null ? "null" : typeof listed}`); break; }
      if (listed.length === 0) break;
      events.push(...listed);
      const last = Number((listed[listed.length - 1] as { seq?: unknown })?.seq ?? 0);
      if (!Number.isFinite(last) || last <= cursor || listed.length < EVENT_PAGE) break;
      cursor = last;
    }
    return events;
  }

  /** The rendered trajectory of one thread, cut to one task's turns when a task id is given (sticky writers share a thread). */
  async function trajectory(threadId: string, taskId?: string): Promise<{ events: number; sliced: number; text: string }> {
    const events = await listThreadEvents(threadId);
    const sliced = taskId ? sliceAttemptEvents(events as ThreadEventLike[], taskId) : events as ThreadEventLike[];
    return { events: events.length, sliced: sliced.length, text: renderThreadEvents(sliced, { maxChars: TRAJECTORY_MAX_CHARS }) };
  }

  /** The area's recent finished attempts with everything the editor may cite. */
  async function collectEvidence(projectId: string, area: string, writerKey: string, limit: number, sinceMs: number, filter?: { attemptIds?: string[] }): Promise<AttemptEvidence[]> {
    const rows = db.prepare(`SELECT a.id, a.task_id AS taskId, a.attempt_no AS attemptNo, a.state, a.reason, a.created_at AS createdAt, a.thread_id AS threadId, a.run_id AS runId,
        t.contract_json AS contract, x.trace_json AS trace
      FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_task t ON t.id=a.task_id LEFT JOIN lane_pilot_attempt_reasoning x ON x.attempt_id=a.id
      WHERE r.project_id=? AND a.created_at>=? AND a.task_id NOT LIKE 'drill-%' AND a.state IN ('accepted','blocked','validation_failed','empty_output')
        AND COALESCE(json_extract(t.contract_json,'$.area'),'')=?
        AND (?='*' OR COALESCE(json_extract(x.trace_json,'$.dispatchContext.writerKey'),'*') IN (?, '*'))
        ${filter?.attemptIds?.length ? `AND a.id IN (${filter.attemptIds.map(() => "?").join(",")})` : ""}
      ORDER BY a.created_at DESC LIMIT ?`)
      .all(projectId, sinceMs, area, writerKey, writerKey, ...(filter?.attemptIds ?? []), limit) as Array<{ id: string; taskId: string; attemptNo: number; state: string; reason: string | null; createdAt: number; threadId: string | null; runId: string; contract: string; trace: string | null }>;
    const receipt = db.prepare("SELECT result_json FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=? ORDER BY updated_at DESC LIMIT 1");
    const out: AttemptEvidence[] = [];
    for (const row of rows) {
      const parse = (json: string | null | undefined): Record<string, unknown> | null => { try { return json ? JSON.parse(json) as Record<string, unknown> : null; } catch { return null; } };
      const trace = parse(row.trace);
      const dispatch = (trace?.dispatchContext ?? null) as AttemptEvidence["dispatch"] & { skillPick?: { skills?: string[] }; harness?: { id?: string; arm?: string } } | null;
      const acceptance = parse((receipt.get(row.runId, row.taskId, "acceptance-receipt") as { result_json: string | null } | undefined)?.result_json);
      const verification = parse((receipt.get(row.runId, row.taskId, "verification") as { result_json: string | null } | undefined)?.result_json);
      const critique = parse((receipt.get(row.runId, row.taskId, "code-critique") as { result_json: string | null } | undefined)?.result_json);
      const events = row.threadId ? sliceAttemptEvents(await listThreadEvents(row.threadId) as ThreadEventLike[], row.taskId) : null;
      out.push({
        attemptId: row.id, taskId: row.taskId, attemptNo: row.attemptNo, state: row.state, reason: row.reason, createdAt: row.createdAt,
        contract: parse(row.contract) ?? {},
        dispatch: dispatch ? { rulesText: dispatch.rulesText, memoryText: dispatch.memoryText, promptChars: dispatch.promptChars, skills: dispatch.skillPick?.skills, harness: dispatch.harness } : null,
        events: events as AttemptEvidence["events"],
        output: typeof acceptance?.output === "string" ? acceptance.output : null,
        verification: (Array.isArray(verification?.verification) ? verification!.verification : Array.isArray(acceptance?.verification) ? acceptance!.verification : []) as AttemptEvidence["verification"],
        critique: critique as AttemptEvidence["critique"],
      });
    }
    return out;
  }

  function libraryEntries(projectId: string, area: string): LibraryEntry[] {
    return listExperiences(db, projectId, area).map((row) => ({
      id: row.harnessId, tree: row.harness.tree, createdAt: row.createdAt, state: row.harness.state,
      experienceMd: renderExperienceMarkdown({ title: `${row.harness.area || "(whole project)"} v${row.harness.version} (${row.harness.state}${row.harness.reason ? `: ${row.harness.reason}` : ""})`, adopted: row.harness.id, inventory: inventory(row.harness.tree), why: row.harness.notes ?? "", rows: parseEdits(`<edits>${row.editsMd}</edits>`), experience: row.cue && row.lesson && row.evidence ? { cue: row.cue, lesson: row.lesson, evidence: row.evidence, confidence: (row.confidence as "high" | "medium" | "low" | null) ?? "" } : null }),
    }));
  }

  /**
   * Where the editor works: the folder the key's writers ran in (the newest run's host and workspace), so the evidence and
   * the sessions sit next to the repository they describe. The project binding is the fallback; a binding without a
   * folder (the global override) is no place at all, and a folder that is gone from the host is refused before anything
   * is written there (the first live run failed on `spawn /bin/bash ENOENT`: a missing cwd, 2026-10-18).
   */
  async function place(projectId: string, area = ""): Promise<{ hostId: string; path: string } | null> {
    const candidates: Array<{ hostId: string | null; path: string | null }> = [
      db.prepare(`SELECT r.writer_host_id AS hostId, r.writer_workspace_path AS path FROM lane_pilot_run r JOIN lane_pilot_task t ON t.run_id=r.id
        WHERE r.project_id=? AND r.writer_workspace_path IS NOT NULL AND r.writer_host_id IS NOT NULL AND COALESCE(json_extract(t.contract_json,'$.area'),'')=?
        ORDER BY r.updated_at DESC LIMIT 1`).get(projectId, area) as { hostId: string | null; path: string | null } | undefined ?? { hostId: null, path: null },
      db.prepare("SELECT writer_host_id AS hostId, writer_workspace_path AS path FROM lane_pilot_run WHERE project_id=? AND writer_workspace_path IS NOT NULL AND writer_host_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
        .get(projectId) as { hostId: string | null; path: string | null } | undefined ?? { hostId: null, path: null },
    ];
    const resolved = await services.resolveProjectWriterHost({ projectId }).catch(() => null);
    if (resolved && resolved.status === "resolved" && resolved.hostId && resolved.path) candidates.push({ hostId: resolved.hostId, path: resolved.path });
    for (const candidate of candidates) {
      if (!candidate.hostId || !candidate.path) continue;
      const exists = await runOnHost(host, { hostId: candidate.hostId, cwd: "/", command: `test -d ${shellQuote(candidate.path)} && echo @@DIR`, timeoutSec: 15 }).catch(() => null);
      if (exists?.stdout.includes("@@DIR")) return { hostId: candidate.hostId, path: candidate.path };
    }
    return null;
  }

  /** Writes files in commands under the host shell's argument limit (`writeFileCommands`): trajectories are long. */
  async function writeFiles(where: { hostId: string; path: string }, dir: string, files: Record<string, string>): Promise<void> {
    for (const command of writeFileCommands(dir, files)) {
      const ran = await runOnHost(host, { hostId: where.hostId, cwd: where.path, command, timeoutSec: 120 });
      if (ran.exitCode !== 0 || !ran.stdout.includes("@@WRITTEN")) throw new Error(`could not write the evidence under ${dir}: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`);
    }
  }

  type Session = StageSession;

  /** A step of a graph run that starts helper threads: its context, the helper runner (workflow/server's, passed in), and the runs it made (for the usage the step reports). */
  type GraphStep = HarnessStep;
  const stopped = (step: GraphStep): boolean => ctx.isDisposed() || step.c.signal.aborted;

  /**
   * One agentic session over a folder, as a helper of the graph step that asked: spawn (a journal effect named by `key`), wait until idle, read the
   * reply and harvest `context/harness/`. A session that fails gives `error` (the stage loop decides what to do), unless the plugin is going away.
   */
  async function session(input: { projectId: string; where: { hostId: string; path: string }; folder: string; title: string; mission: string; role: string; cfg: HarnessConfig; harvest: boolean; model?: HarnessRole; step: GraphStep; key: string }): Promise<Session> {
    const selection = roleSelection(input.cfg, input.model ?? "inv");
    const cwd = `${input.where.path}/${input.folder}`;
    let threadId: string | null = null;
    try {
      // A finished session is a record, not a conversation: it leaves the project's thread list (the owner saw a dozen
      // «Lane Pilot harness editor …» rows on 2026-10-19). The notes, the tree and the decision are stored on the hub.
      const run = await input.step.helper({
        key: input.key, label: "harness_session_timeout", waitMs: input.cfg.waitMinutes * 60_000, projectId: input.projectId, archive: true,
        spawn: async (graph) => {
          const spawned = await fullAccessSpawn(bb, {
            projectId: input.projectId,
            environment: { type: "host", hostId: input.where.hostId, workspace: { type: "unmanaged", path: cwd } },
            title: input.title, prompt: input.mission,
            ...writerExecutionSelection(selection.providerId, selection.model, selection.reasoningLevel, "default"),
            pluginMetadata: { role: input.role, lanePilotProjectId: input.projectId, harnessFolder: input.folder, model: `${selection.providerId}/${selection.model}`, ...graph.metadata, spawnId: graph.spawnId },
          } as Parameters<typeof fullAccessSpawn>[1]);
          const id = stringAt(spawned, "id");
          if (!id) throw new Error("spawn returned no thread id");
          threadId = id;
          return id;
        },
      });
      threadId = run.threadId;
      input.step.runs.push(run);
      let tree: Tree | null = null;
      if (input.harvest) {
        const harvested = await runOnHost(host, { hostId: input.where.hostId, cwd, command: harvestCommand(), timeoutSec: 60 });
        tree = parseHarvest(harvested.stdout);
      }
      return { threadId, text: run.text, tree, error: null };
    } catch (cause) {
      if (stopped(input.step)) throw cause;
      return { threadId, text: "", tree: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** A stage with its one retry on a rejected tree and one on a session that ended early (`runStage`); each session of it is a helper named `<label>:<n>`. */
  async function stage(input: Omit<Parameters<typeof session>[0], "harvest" | "key"> & { fallback: Tree; label: string; surface?: typeof LANE_PILOT_SURFACE }): Promise<StageResult> {
    let sessions = 0;
    const { surface, fallback, label, ...rest } = input;
    return runStage({ mission: input.mission, fallback, title: input.title, surface },
      (mission) => session({ ...rest, mission, harvest: true, key: `${label}:${++sessions}` }), (line) => ctx.log(line), HARNESS_TUNING.retryDelayMs);
  }

  /**
   * Step `prepare` of `lp.harness-edit`: whether a round may start for the key, and where it works. Nothing is written yet.
   * A key with no reachable folder fails the step (the editor has nowhere to work: that is a failure of the setup, not a quiet skip).
   */
  async function prepareEdit(input: { projectId: string; area: string; writerKey: string }): Promise<{ status: "ready" | "skipped"; detail: string; hostId: string; path: string }> {
    const none = { hostId: "", path: "" };
    const cfg = await config(input.projectId);
    if (!cfg.enabled) return { status: "skipped", detail: "harness editing is off for this project", ...none };
    if (trialHarness(db, input.projectId, input.area, input.writerKey)) return { status: "skipped", detail: "a candidate is already on trial for this key", ...none };
    const openTrials = listHarnesses(db, input.projectId, { states: ["trial"] }).length;
    if (openTrials >= cfg.trial.maxOpen) return { status: "skipped", detail: `frozen: ${openTrials} trial(s) already open (trial.max_open ${cfg.trial.maxOpen})`, ...none };
    const where = await place(input.projectId, input.area);
    if (!where) throw new Error("no reachable folder for the editor: the key's runs name no host and workspace, and the project binding has no folder");
    return { status: "ready", detail: "", hostId: where.hostId, path: where.path };
  }

  /**
   * Step `edit` of `lp.harness-edit`, the model work of one improvement round for a key: evidence on disk, two editors (invariant, domain) in
   * parallel, one composer. KEEP_BASE at any stage ends the round with nothing to put on trial. Every session is a helper thread of the step; the
   * step returns what the round made (the composed tree, the editors' notes) and `validate` decides what to do with it.
   */
  async function editRound(step: GraphStep, input: { projectId: string; area: string; writerKey: string; where: { hostId: string; path: string }; stamp: string }): Promise<Record<string, unknown>> {
    const { projectId, area, writerKey, where } = input;
    const key = `${projectId}:${area}:${writerKey}`;
    const cfg = await config(projectId);
    const active = activeHarness(db, projectId, area, writerKey);
    const attempts = await collectEvidence(projectId, area, writerKey, cfg.attemptsPerEvidence, Date.now() - cfg.windowDays * 86_400_000);
    if (attempts.length === 0) return { status: "skipped", detail: "no finished attempts of this key in the window", tree: {}, inv_notes: "", dom_notes: "", compose_notes: "", thread_ids: [] };
    const library = libraryEntries(projectId, area);
    const round = `${HARNESS_DIR}-edit/${slug(area || "project")}__${slug(writerKey)}/${input.stamp}`;
    await runOnHost(host, { hostId: where.hostId, cwd: where.path, command: ensureExcludeLinesCommand([".lane-pilot/"]), timeoutSec: 30 }).catch(() => undefined);
    const base = evidenceFiles({ area, writerKey, attempts, harness: active.tree, library, repoPath: where.path });
    const surface = cfg.graphEdits ? { ...LANE_PILOT_SURFACE, graphFiles: true } : LANE_PILOT_SURFACE;
    const promptCtx = { area: area || "(whole project)", writerKey, surface };
    const rejected = rejectedFor(projectId, area, writerKey);
    await Promise.all(["inv", "dom"].map((label) => writeFiles(where, `${round}/${label}`, base)));
    const layout = evidenceLayout(base);
    // The two editors run side by side, the second one started a little later: two OpenCode processes starting on the
    // same host within two seconds collided on OpenCode's database («thread.start failed … database is locked»,
    // BB-сервис feature:shell, 2026-10-19 04:10 UTC). The self-repair's second session covers the rest.
    const [inv, dom] = await Promise.all((["INV", "DOM"] as const).map(async (dim, index) => { if (index > 0) await new Promise((resolve) => setTimeout(resolve, HARNESS_TUNING.editorStaggerMs)); return stage({
      projectId, where, folder: `${round}/${dim.toLowerCase()}`, cfg, fallback: active.tree, step, label: dim.toLowerCase(),
      title: `Lane Pilot harness editor (${dim}): ${area || "project"} / ${writerKey}`, role: "harness-editor", model: dim === "INV" ? "inv" : "dom",
      mission: missionPointer(proposePrompt(dim, promptCtx, rejected), layout), surface,
    }); }));
    const threadIds = [...inv.threadIds, ...dom.threadIds];
    const common = { inv_notes: inv.notes, dom_notes: dom.notes, compose_notes: "" };
    for (const [label, result] of [["inv", inv], ["dom", dom]] as const) if (result.error) ctx.log(`harness ${key}: ${label} editor failed: ${result.error}`);
    // Two failed editors kept nothing: the nightly line said «keep_base: both editors kept the current harness» for a
    // round where neither got to edit (BB-сервис feature:shell, 2026-10-19).
    if (inv.error && dom.error) return { status: "failed", detail: `both editors failed: inv ${inv.error}; dom ${dom.error}`, tree: {}, ...common, thread_ids: threadIds };
    if (inv.keptBase && dom.keptBase) return { status: "keep_base", detail: "both editors kept the current harness", tree: {}, ...common, thread_ids: threadIds };
    const pool: PoolCandidate[] = [{ label: "inv", tree: inv.tree, diff: treeDiff(active.tree, inv.tree), notes: inv.notes }, { label: "dom", tree: dom.tree, diff: treeDiff(active.tree, dom.tree), notes: dom.notes }];
    const probeHost: HostPort = { run: async (hostId, cwd, command, timeoutSec = 60) => runOnHost(host, { hostId, cwd, command, timeoutSec }) };
    const probeTasks = attempts.map((attempt) => {
      const git = getTaskGitBase(db, attempt.taskId);
      const raw = attempt.contract.verification;
      const verification = Array.isArray(raw) ? raw.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const command = (item as { command?: unknown }).command;
        if (typeof command !== "string" || !command.trim()) return [];
        const cwd = (item as { cwd?: unknown }).cwd;
        return [{ command, ...(typeof cwd === "string" ? { cwd } : {}) }];
      }) : [];
      const tokens = Math.max(1, Math.ceil((attempt.dispatch?.promptChars ?? 0) / 4));
      return { attemptId: attempt.attemptId, sha: git?.base_sha || git?.initial_head_sha || "", tokens, verification };
    });
    let probe = "";
    try {
      const replays = await runHarnessProbe({
        host: probeHost, hostId: where.hostId, checkout: `/tmp/lp-harness-probe-${slug(area || "project")}`, repo: where.path,
        candidates: pool.map((candidate) => ({ label: candidate.label, tree: candidate.tree })), tasks: probeTasks, budget: cfg.probe,
      });
      probe = formatProbeReplays(replays);
    } catch (cause) {
      probe = `# Overnight probe\n\nThe replay did not run: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    const composeFiles = evidenceFiles({ area, writerKey, attempts, harness: active.tree, library, pool, decisions: { inv: inv.notes || inv.error || "", dom: dom.notes || dom.error || "" }, repoPath: where.path, ...(probe ? { probe } : {}) });
    await writeFiles(where, `${round}/compose`, composeFiles);
    const composed = await stage({
      projectId, where, folder: `${round}/compose`, cfg, fallback: active.tree, step, label: "compose",
      title: `Lane Pilot harness composer: ${area || "project"} / ${writerKey}`, role: "harness-composer", model: "compose",
      mission: missionPointer(composePrompt(promptCtx, 2), evidenceLayout(composeFiles)), surface,
    });
    threadIds.push(...composed.threadIds);
    if (composed.error) ctx.log(`harness ${key}: composer failed: ${composed.error}`);
    const notes = { ...common, compose_notes: composed.notes };
    if (composed.keptBase) return { status: "keep_base", detail: composed.error ? `composer failed (${composed.error}); the current harness stays` : "the composer kept the current harness", tree: {}, ...notes, thread_ids: threadIds };
    return { status: "edited", detail: "", tree: composed.tree, ...notes, thread_ids: threadIds };
  }

  /**
   * Step `validate` of `lp.harness-edit`: what the round made goes on trial as a candidate tree (alternating with the active one on the key's next
   * tasks), or is recorded as «kept the base». A round that failed (both editors, or the composer's spawn) fails the step. Run again after a reload it
   * finds the candidate it already made.
   */
  async function validateEdit(input: { projectId: string; area: string; writerKey: string; reason: string | null }, edit: Record<string, unknown>): Promise<{ status: "trial" | "keep_base" | "skipped"; detail: string; candidateId: string }> {
    const { projectId, area, writerKey } = input;
    const key = `${projectId}:${area}:${writerKey}`;
    const status = typeof edit.status === "string" ? edit.status : "failed";
    const detail = typeof edit.detail === "string" ? edit.detail : "";
    const notes = { inv: String(edit.inv_notes ?? ""), dom: String(edit.dom_notes ?? ""), ...(String(edit.compose_notes ?? "") ? { compose: String(edit.compose_notes) } : {}) };
    if (status === "skipped") return { status: "skipped", detail, candidateId: "" };
    if (status === "keep_base") {
      await bb.storage.kv.set(LAST_EDIT_KEY(projectId, area, writerKey), { at: Date.now(), result: "keep_base", notes } as never);
      return { status: "keep_base", detail, candidateId: "" };
    }
    if (status !== "edited") throw new Error(detail || "the harness round failed");
    const tree = edit.tree as Tree;
    const surface = (await config(projectId)).graphEdits ? { ...LANE_PILOT_SURFACE, graphFiles: true } : LANE_PILOT_SURFACE;
    try {
      validate(tree, { surface });
      if (surface.graphFiles) {
        const graphProblems = graphEditProblems(tree);
        if (graphProblems.length) throw new HarnessValidationError(graphProblems);
      }
    } catch (cause) { throw new Error(`the composed tree is not valid: ${cause instanceof Error ? cause.message : String(cause)}`); }
    const refused = screenRejected(fingerprint(tree), rejectedFor(projectId, area, writerKey));
    if (refused.blocked) {
      await bb.storage.kv.set(LAST_EDIT_KEY(projectId, area, writerKey), { at: Date.now(), result: "keep_base", reason: refused.reason } as never);
      return { status: "keep_base", detail: `already rejected (${fingerprint(tree)}): ${refused.reason}`, candidateId: "" };
    }
    const open = trialHarness(db, projectId, area, writerKey);
    if (open) return { status: "trial", detail: inventory(open.tree), candidateId: open.id };
    // J-001 freeze: with `trial.max_open` or more trials already open the project takes no new candidates until one decides.
    const openCount = listHarnesses(db, projectId, { states: ["trial"] }).length;
    const maxOpen = (await config(projectId)).trial.maxOpen;
    if (openCount >= maxOpen) return { status: "keep_base", detail: `frozen: ${openCount} trial(s) already open (trial.max_open ${maxOpen}); new candidates wait for a verdict`, candidateId: "" };
    const active = activeHarness(db, projectId, area, writerKey);
    const candidate = insertHarness(db, { projectId, area, writerKey, tree, state: "trial", createdBy: "editor", parentId: active.id,
      notes: [`## inv\n${notes.inv}`, `## dom\n${notes.dom}`, `## compose\n${notes.compose ?? ""}`].join("\n\n").slice(0, 20_000), reason: input.reason });
    await bb.storage.kv.set(LAST_EDIT_KEY(projectId, area, writerKey), { at: Date.now(), result: "trial", candidateId: candidate.id } as never);
    ctx.log(`harness ${key}: candidate ${candidate.id} on trial (${inventory(candidate.tree)}) from threads ${(edit.thread_ids as string[] | undefined ?? []).join(", ")}`);
    ctx.realtime.notify(projectId, "harness");
    return { status: "trial", detail: inventory(candidate.tree), candidateId: candidate.id };
  }

  const TERMINAL_RUN = ["succeeded", "failed", "blocked", "interrupted", "canceled", "not_verified"];

  /**
   * One improvement round for a key, as a run of the graph `lp.harness-edit` (prepare, edit, validate). The key's lock, the switch and the open-trial
   * check stay here; `night` makes the run the night's own (a second start the same night finds it), a manual round has none.
   */
  async function runEditor(input: { projectId: string; area: string; writerKey: string; reason?: string; night?: string }): Promise<{ status: "started" | "trial" | "keep_base" | "skipped" | "failed"; detail: string; candidateId?: string; threadIds: string[] }> {
    const area = input.area.trim(), writerKey = input.writerKey || ANY_WRITER;
    const key = `${input.projectId}:${area}:${writerKey}`;
    if (running.has(key)) return { status: "skipped", detail: "an editor is already running for this key", threadIds: [] };
    const cfg = await config(input.projectId);
    if (!cfg.enabled) return { status: "skipped", detail: "harness editing is off for this project", threadIds: [] };
    if (trialHarness(db, input.projectId, area, writerKey)) return { status: "skipped", detail: "a candidate is already on trial for this key", threadIds: [] };
    const runKey = `harness-edit:${key}:${input.night ?? Date.now()}`;
    const prior = db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(runKey) as { status: string } | undefined;
    if (prior && TERMINAL_RUN.includes(prior.status)) return { status: "skipped", detail: "the round of this night already ran", threadIds: [] };
    const workflow = builtinWorkflow(HARNESS_EDIT_WORKFLOW);
    if (!workflow) return { status: "failed", detail: `built-in workflow ${HARNESS_EDIT_WORKFLOW} is not loaded`, threadIds: [] };
    running.add(key);
    try {
      const started = services.workflowEngine.start({
        workflow, key: runKey, link: { projectId: input.projectId }, runtime: { ctx, services, pmThreadId: null, projectId: input.projectId, runId: null } satisfies ChainRuntime,
        inputs: { project_id: input.projectId, area, writer_key: writerKey, reason: input.reason ?? "" },
      });
      const summary = await started.done;
      if (summary.status !== "succeeded") return { status: "failed", detail: summary.error ?? summary.reason ?? `the harness round ${summary.status}`, threadIds: [] };
      const out = summary.output ?? {};
      const status = out.status === "trial" || out.status === "keep_base" ? out.status : "skipped";
      return { status, detail: String(out.detail ?? ""), ...(typeof out.candidate_id === "string" && out.candidate_id ? { candidateId: out.candidate_id } : {}), threadIds: Array.isArray(out.thread_ids) ? out.thread_ids.map(String) : [] };
    } catch (cause) {
      return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause), threadIds: [] };
    } finally {
      running.delete(key);
    }
  }

  /** The newest bench comparison on a tree and the rule that decides who adopts (`adoptBy`). */
  function benchInput(cfg: HarnessConfig, harnessId: string): { adoptBy: AdoptBy; verdict: { passed: boolean; summary: string } | null } {
    const verdict = verdictForHarness(db, harnessId);
    const report = verdict?.report as { armA?: string; armB?: string; verdict?: string } | null | undefined;
    return { adoptBy: cfg.adoptBy, verdict: verdict ? { passed: verdict.passed, summary: `${report?.armB ?? verdict.armB} vs ${report?.armA ?? verdict.armA} on set ${verdict.setId.replace("benchset_", "")}` } : null };
  }

  /** The trials of a project judged on their attempts; a decided trial gets its reflection. */
  async function evaluateTrials(projectId: string, options: { dryRun?: boolean; now?: number } = {}): Promise<Array<{ id: string; area: string; writerKey: string; decision: TrialDecision }>> {
    const cfg = await config(projectId);
    const now = options.now ?? Date.now();
    const out: Array<{ id: string; area: string; writerKey: string; decision: TrialDecision }> = [];
    for (const trial of listHarnesses(db, projectId, { states: ["trial"] })) {
      const rows = trialAttempts(db, trial);
      const decision = decideTrial(rows, trial.trialStartedAt ?? trial.createdAt, now, cfg.trial, benchInput(cfg, trial.id));
      out.push({ id: trial.id, area: trial.area, writerKey: trial.writerKey, decision });
      if (options.dryRun || decision.action === "wait") continue;
      if (decision.action === "adopt") {
        const parent = trial.parentId ? getHarness(db, trial.parentId) : null;
        if (parent && parent.state === "adopted") setHarnessState(db, parent.id, "retired", `replaced by ${trial.id}`, now);
        setHarnessState(db, trial.id, "adopted", decision.reason, now);
        ctx.log(`harness ${projectId}:${trial.area}:${trial.writerKey}: adopted ${trial.id}: ${decision.reason}`);
      } else {
        setHarnessState(db, trial.id, "retired", decision.reason, now);
        ctx.log(`harness ${projectId}:${trial.area}:${trial.writerKey}: retired ${trial.id}: ${decision.reason}`);
      }
      ctx.realtime.notify(projectId, "harness");
      void reflect(trial.id).catch((cause) => ctx.log(`harness reflection for ${trial.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
    return out;
  }

  /**
   * Step `prepare` of `lp.harness-reflect`: the evidence of both arms of a decided trial is written beside the repository and the reflection's mission
   * is made. A trial that has not decided is skipped; one with no reachable folder fails the step.
   */
  async function prepareReflect(trialId: string): Promise<{ status: "ready" | "skipped"; detail: string; projectId: string; hostId: string; path: string; folder: string; mission: string }> {
    const none = { projectId: "", hostId: "", path: "", folder: "", mission: "" };
    const trial = getHarness(db, trialId);
    if (!trial || !["adopted", "retired"].includes(trial.state)) return { status: "skipped", detail: "the trial has not decided", ...none };
    const cfg = await config(trial.projectId);
    const where = await place(trial.projectId, trial.area);
    if (!where) throw new Error("no reachable folder for the reflection");
    const parent = trial.parentId ? getHarness(db, trial.parentId) : null;
    const rows = trialAttempts(db, trial);
    const pick = (arm: "new" | "old") => rows.filter((row) => row.arm === arm).slice(-3).map((row) => row.attemptId);
    const attempts = await collectEvidence(trial.projectId, trial.area, trial.writerKey, 6, 0, { attemptIds: [...pick("new"), ...pick("old")] });
    const decision = decideTrial(rows, trial.trialStartedAt ?? trial.createdAt, Date.now(), cfg.trial, benchInput(cfg, trial.id));
    const files = evidenceFiles({
      area: trial.area, writerKey: trial.writerKey, attempts, harness: trial.tree, baseHarness: parent?.tree ?? {}, library: libraryEntries(trial.projectId, trial.area),
      pool: [{ label: "candidate", tree: trial.tree, diff: treeDiff(parent?.tree ?? {}, trial.tree), notes: trial.notes ?? "" }],
      decisions: { trial: `${trial.state}: ${trial.reason ?? ""}\n\n${JSON.stringify(decision.arms, null, 2)}`, editors: trial.notes ?? "" },
    });
    const folder = `${HARNESS_DIR}-edit/${slug(trial.area || "project")}__${slug(trial.writerKey)}/reflect-${trial.id}`;
    await writeFiles(where, folder, files);
    const mission = missionPointer(`${experiencePrompt({ area: trial.area || "(whole project)", writerKey: trial.writerKey })}\n\n# WHAT HAPPENED\n\nThe candidate (context/pool/candidate/, also context/harness/) was ${trial.state}: ${trial.reason ?? ""}. Attempts of both arms are under context/attempts/ (brief.md names the tree and arm). Compare context/harness/ with context/base_harness/.`, evidenceLayout(files));
    return { status: "ready", detail: "", projectId: trial.projectId, hostId: where.hostId, path: where.path, folder, mission };
  }

  /** Step `reflect` of `lp.harness-reflect`: the one session that reads both arms. A session that fails fails the step. */
  async function reflectSession(step: GraphStep, trialId: string, prepared: { projectId: string; hostId: string; path: string; folder: string; mission: string }): Promise<string> {
    const trial = getHarness(db, trialId);
    if (!trial) throw new Error(`harness ${trialId} is gone`);
    const result = await session({ projectId: prepared.projectId, where: { hostId: prepared.hostId, path: prepared.path }, folder: prepared.folder, cfg: await config(prepared.projectId), harvest: false, role: "harness-reflection", model: "reflect",
      title: `Lane Pilot harness reflection: ${trial.area || "project"} / ${trial.writerKey}`, mission: prepared.mission, step, key: "reflect" });
    if (result.error) throw new Error(result.error);
    return result.text;
  }

  /** Step `record` of `lp.harness-reflect`: what each edit did and the one lesson that transfers, into the library and the rules pipeline. */
  function recordReflect(trialId: string, answer: string): { status: "done"; detail: string } {
    const trial = getHarness(db, trialId);
    if (!trial) throw new Error(`harness ${trialId} is gone`);
    const edits = parseEdits(answer);
    const experience = parseExperience(answer);
    const supported = experienceIsSupported(experience, edits);
    let ruleId: string | null = null;
    if (experience && supported) {
      const proposal = upsertLessonProposal(db, trial.projectId, { rule: experience.lesson, evidence: `${experience.evidence} (harness ${trial.id}, ${trial.state})`, audience: "writer", form: inferForm(experience.lesson), cue: experience.cue, confidence: experience.confidence || null });
      ruleId = proposal.id;
    }
    const editsMd = edits.map((row) => `component: ${row.component}\ncandidates: ${row.candidates}\nchange: ${row.change}\nobserved: ${row.observed}\nverdict: ${row.verdict}`).join("\n");
    saveExperience(db, { harnessId: trial.id, editsMd, cue: supported ? experience!.cue : null, lesson: supported ? experience!.lesson : null, evidence: supported ? experience!.evidence : null, confidence: supported ? experience!.confidence || null : null, ruleId });
    ctx.realtime.notify(trial.projectId, "harness");
    return { status: "done", detail: `${edits.length} edit rows, ${supported ? `lesson → ${ruleId}` : "NO_ENTRY"}` };
  }

  /** After a trial decided: what each edit did, and the one lesson that transfers, as a run of the graph `lp.harness-reflect` (named by the trial: it runs once). */
  async function reflect(trialId: string): Promise<{ status: "done" | "skipped" | "failed"; detail: string }> {
    const trial = getHarness(db, trialId);
    if (!trial || !["adopted", "retired"].includes(trial.state)) return { status: "skipped", detail: "the trial has not decided" };
    const workflow = builtinWorkflow(HARNESS_REFLECT_WORKFLOW);
    if (!workflow) return { status: "failed", detail: `built-in workflow ${HARNESS_REFLECT_WORKFLOW} is not loaded` };
    try {
      const started = services.workflowEngine.start({
        workflow, key: `harness-reflect:${trialId}`, link: { projectId: trial.projectId }, runtime: { ctx, services, pmThreadId: null, projectId: trial.projectId, runId: null } satisfies ChainRuntime,
        inputs: { project_id: trial.projectId, trial_id: trialId },
      });
      const summary = await started.done;
      if (summary.status !== "succeeded") return { status: "failed", detail: summary.error ?? summary.reason ?? `the reflection ${summary.status}` };
      const out = summary.output ?? {};
      return { status: out.status === "done" ? "done" : "skipped", detail: String(out.detail ?? "") };
    } catch (cause) {
      return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function teachingProjects(since: number): Promise<string[]> {
    const ids = (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_run WHERE updated_at>=?").all(since) as Array<{ project_id: string }>).map((row) => row.project_id);
    const kept: string[] = [];
    for (const projectId of ids) {
      if (projectId === SANDBOX_PROJECT_ID) continue;
      const project = await bb.sdk.projects.get({ projectId }).catch(() => null) as { name?: string } | null;
      if (isSandboxProjectName(project?.name)) continue;
      kept.push(projectId);
    }
    return kept;
  }

  /** One night's work for a project: judge the trials, then start editors for the keys with enough new attempts. */
  async function tick(projectId: string, options: { dryRun?: boolean; night?: string } = {}): Promise<{ trials: Awaited<ReturnType<typeof evaluateTrials>>; editors: Array<{ area: string; writerKey: string; attempts: number; result: string }> }> {
    const cfg = await config(projectId);
    const trials = await evaluateTrials(projectId, { dryRun: options.dryRun });
    const editors: Array<{ area: string; writerKey: string; attempts: number; result: string }> = [];
    if (!cfg.enabled) return { trials, editors };
    const since = Date.now() - cfg.windowDays * 86_400_000;
    let started = 0;
    for (const key of teachingKeys(db, projectId, since, cfg.minAttempts, cfg.minSpanDays * 86_400_000)) {
      if (started >= cfg.maxKeysPerNight || ctx.isDisposed()) break;
      if (trialHarness(db, projectId, key.area, key.writerKey)) { editors.push({ ...key, result: "trial running" }); continue; }
      const last = await bb.storage.kv.get(LAST_EDIT_KEY(projectId, key.area, key.writerKey)).catch(() => null) as { at?: number } | null;
      if (last?.at && Date.now() - last.at < cfg.windowDays * 86_400_000) { editors.push({ ...key, result: "edited recently" }); continue; }
      if (options.dryRun) { editors.push({ ...key, result: "would start an editor" }); started++; continue; }
      const result = await runEditor({ projectId, area: key.area, writerKey: key.writerKey, ...(options.night ? { night: options.night } : {}), reason: `nightly:${key.attempts} attempts in ${cfg.windowDays} days` });
      editors.push({ ...key, result: `${result.status}: ${result.detail}` });
      started++;
    }
    return { trials, editors };
  }

  async function status(projectId: string) {
    const cfg = await config(projectId);
    const trees = listHarnesses(db, projectId, { states: ["base", "adopted", "trial"] });
    const trials = trees.filter((row) => row.state === "trial").map((row) => ({ id: row.id, area: row.area, writerKey: row.writerKey, since: row.trialStartedAt, decision: decideTrial(trialAttempts(db, row), row.trialStartedAt ?? row.createdAt, Date.now(), cfg.trial, benchInput(cfg, row.id)) }));
    const recent = listHarnesses(db, projectId, { states: ["retired"] }).slice(0, 10).map((row) => ({ id: row.id, area: row.area, writerKey: row.writerKey, reason: row.reason, decidedAt: row.decidedAt }));
    return {
      config: cfg,
      roleModels: Object.fromEntries(HARNESS_ROLES.map((role) => [role, roleSelection(cfg, role)])) as Record<HarnessRole, ModelSelection>,
      keys: teachingKeys(db, projectId, Date.now() - cfg.windowDays * 86_400_000, 1),
      active: trees.filter((row) => row.state !== "trial").map((row) => ({ id: row.id, area: row.area, writerKey: row.writerKey, state: row.state, version: row.version, inventory: inventory(row.tree), tree: row.tree })),
      trials, retired: recent,
      running: [...running],
    };
  }

  scheduleIsolated(bb, "harness-nightly", "10 4 * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    for (const projectId of await teachingProjects(Date.now() - 30 * 86_400_000)) {
      if (ctx.isDisposed() || signal?.aborted) return;
      const result = await tick(projectId, { night: new Date().toISOString().slice(0, 10) }).catch((cause) => { ctx.log(`harness nightly for ${projectId} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (result) bb.log.info(`Lane Pilot harness nightly ${projectId}: ${result.trials.length} trials judged, editors: ${result.editors.map((row) => `${row.area || "project"}/${row.writerKey}=${row.result}`).join("; ") || "none"}`);
    }
  }, { timeoutMs: 5 * 3_600_000 });

  /** The code and session steps the graphs `lp.harness-edit` and `lp.harness-reflect` wrap (night-graphs/server/harness-graph.ts). */
  const graph = { prepareEdit, editRound, validateEdit, prepareReflect, reflectSession, recordReflect };
  return { config, setConfig, forAttempt, materialize, checksForAttempt, checksForWriterThread, runEditor, evaluateTrials, reflect, tick, status, trajectory, graph };
}

export type HarnessApi = ReturnType<typeof createHarness>;
