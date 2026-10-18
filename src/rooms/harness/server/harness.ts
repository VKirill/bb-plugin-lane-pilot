import { runOnHost } from "@lane-pilot/host-calls";
import { writerExecutionSelection } from "@lane-pilot/models";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { upsertLessonProposal, type RuleForm } from "@lane-pilot/run-insights";
import {
  HarnessValidationError, LANE_PILOT_SURFACE, alwaysOnText, checkNames, composePrompt, experienceIsSupported, experiencePrompt, inventory, isBase, missionPointer,
  parseEdits, parseExperience, parseNotes, proposePrompt, renderExperienceMarkdown, renderThreadEvents, skillNames, validate, type ThreadEventLike, type Tree,
} from "@lane-pilot/harness-core";
import { fullAccessSpawn, scheduleIsolated, stringAt, type ServerCore, type Services } from "../../core/server";
import { SANDBOX_PROJECT_ID, isSandboxProjectName } from "../../stability/server";
import { ensureExcludeLinesCommand, EXCLUDE_NOT_GIT } from "../../verification";
import { getAttempt } from "../../storage";
import { evidenceFiles, evidenceLayout, harvestCommand, parseHarvest, shellQuote, sliceAttemptEvents, treeDiff, writeFileCommands, type AttemptEvidence, type LibraryEntry, type PoolCandidate } from "./evidence";
import {
  ANY_WRITER, activeHarness, assignAttemptHarness, getHarness, insertHarness, listExperiences, listHarnesses, saveExperience, setHarnessState, teachingKeys, trialAttempts, trialHarness,
  type HarnessRow,
} from "./store";
import { TRIAL_DEFAULTS, decideTrial, type TrialConfig, type TrialDecision } from "./trial";

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
  editor: { providerId: string; model: string; reasoningLevel: string };
  waitMinutes: number;
  trial: TrialConfig;
};

export const HARNESS_DEFAULTS: HarnessConfig = {
  enabled: true, minAttempts: 5, windowDays: 7, maxKeysPerNight: 2, attemptsPerEvidence: 8,
  editor: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }, waitMinutes: 40, trial: TRIAL_DEFAULTS,
};

const CONFIG_KEY = (projectId: string) => `harness:config:${projectId}`;
const LAST_EDIT_KEY = (projectId: string, area: string, writerKey: string) => `harness:last-edit:${projectId}:${area}:${writerKey}`;
export const HARNESS_DIR = ".lane-pilot/harness";
const EXCLUDE_LINES = [".lane-pilot/", ".opencode/skills/", ".claude/skills/"];
const EVENT_PAGE = 100;
const EVENT_PAGES_MAX = 60;
const TRAJECTORY_MAX_CHARS = 120_000;

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

export function createHarness(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;
  const running = new Set<string>();

  async function config(projectId: string): Promise<HarnessConfig> {
    const raw = await bb.storage.kv.get(CONFIG_KEY(projectId)).catch(() => null) as Partial<HarnessConfig> | null;
    return { ...HARNESS_DEFAULTS, ...(raw ?? {}), editor: { ...HARNESS_DEFAULTS.editor, ...(raw?.editor ?? {}) }, trial: { ...TRIAL_DEFAULTS, ...(raw?.trial ?? {}) } };
  }

  async function setConfig(projectId: string, patch: Partial<HarnessConfig>): Promise<HarnessConfig> {
    const next = { ...(await config(projectId)), ...patch, editor: { ...(await config(projectId)).editor, ...(patch.editor ?? {}) }, trial: { ...(await config(projectId)).trial, ...(patch.trial ?? {}) } };
    await bb.storage.kv.set(CONFIG_KEY(projectId), next as never);
    return next;
  }

  /**
   * The tree an attempt runs under. With a trial open for the key the arms alternate by the order attempts are assigned,
   * so both arms see the same stream of tasks; without one the active tree (adopted or base) is recorded with no arm.
   */
  async function forAttempt(input: { projectId: string; area: string | null | undefined; writerKey: string; attemptId: string }): Promise<BriefParts | null> {
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

  type Session = { threadId: string | null; text: string; tree: Tree | null; error: string | null };

  /** One agentic session over a folder: spawn, wait until idle, read the reply and harvest `context/harness/`. */
  async function session(input: { projectId: string; where: { hostId: string; path: string }; folder: string; title: string; mission: string; role: string; cfg: HarnessConfig; harvest: boolean }): Promise<Session> {
    const cwd = `${input.where.path}/${input.folder}`;
    let threadId: string | null = null;
    try {
      const spawned = await fullAccessSpawn(bb, {
        projectId: input.projectId,
        environment: { type: "host", hostId: input.where.hostId, workspace: { type: "unmanaged", path: cwd } },
        title: input.title, prompt: input.mission,
        ...writerExecutionSelection(input.cfg.editor.providerId, input.cfg.editor.model, input.cfg.editor.reasoningLevel, "default"),
        pluginMetadata: { role: input.role, lanePilotProjectId: input.projectId, harnessFolder: input.folder },
      } as Parameters<typeof fullAccessSpawn>[1]);
      threadId = stringAt(spawned, "id") ?? null;
      if (!threadId) return { threadId, text: "", tree: null, error: "spawn returned no thread id" };
      await waitThreadIdle(bb, threadId, "harness_session_timeout", input.cfg.waitMinutes * 60_000);
      const output = await bb.sdk.threads.output({ threadId }).then((result) => { const value = (result as { output?: unknown; text?: unknown }).output ?? (result as { text?: unknown }).text; return typeof value === "string" ? value : ""; }).catch(() => "");
      let tree: Tree | null = null;
      if (input.harvest) {
        const harvested = await runOnHost(host, { hostId: input.where.hostId, cwd, command: harvestCommand(), timeoutSec: 60 });
        tree = parseHarvest(harvested.stdout);
      }
      return { threadId, text: output, tree, error: null };
    } catch (cause) {
      return { threadId, text: "", tree: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** A stage with its one retry on a rejected tree, the way Harness² does it: the error goes back verbatim. */
  async function stage(input: Omit<Parameters<typeof session>[0], "harvest"> & { fallback: Tree }): Promise<{ tree: Tree; keptBase: boolean; notes: string; threadIds: string[]; error: string | null }> {
    const threadIds: string[] = [];
    let mission = input.mission;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await session({ ...input, mission, harvest: true });
      if (result.threadId) threadIds.push(result.threadId);
      if (result.error || !result.tree) { lastError = result.error ?? "no tree came back"; break; }
      const { notes, keepBase } = parseNotes(result.text);
      const tree = result.tree;
      try {
        validate(tree);
      } catch (cause) {
        lastError = cause instanceof HarnessValidationError ? cause.message : String(cause);
        mission = `${input.mission}\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${lastError}\n\nFix it in \`context/harness/\` (the files are still there) and reply again.`;
        continue;
      }
      return { tree, keptBase: keepBase || isBase(input.fallback, tree), notes, threadIds, error: null };
    }
    return { tree: input.fallback, keptBase: true, notes: "", threadIds, error: lastError };
  }

  /**
   * One improvement round for a key: evidence on disk, two editors (invariant, domain) in parallel, one composer, and
   * the composed tree on trial. KEEP_BASE at any stage ends the round with nothing on trial.
   */
  async function runEditor(input: { projectId: string; area: string; writerKey: string; reason?: string }): Promise<{ status: "started" | "trial" | "keep_base" | "skipped" | "failed"; detail: string; candidateId?: string; threadIds: string[] }> {
    const area = input.area.trim(), writerKey = input.writerKey || ANY_WRITER;
    const key = `${input.projectId}:${area}:${writerKey}`;
    if (running.has(key)) return { status: "skipped", detail: "an editor is already running for this key", threadIds: [] };
    const cfg = await config(input.projectId);
    if (!cfg.enabled) return { status: "skipped", detail: "harness editing is off for this project", threadIds: [] };
    if (trialHarness(db, input.projectId, area, writerKey)) return { status: "skipped", detail: "a candidate is already on trial for this key", threadIds: [] };
    const where = await place(input.projectId, area);
    if (!where) return { status: "failed", detail: "no reachable folder for the editor: the key's runs name no host and workspace, and the project binding has no folder", threadIds: [] };
    running.add(key);
    const threadIds: string[] = [];
    try {
      const active = activeHarness(db, input.projectId, area, writerKey);
      const attempts = await collectEvidence(input.projectId, area, writerKey, cfg.attemptsPerEvidence, Date.now() - cfg.windowDays * 86_400_000);
      if (attempts.length === 0) return { status: "skipped", detail: "no finished attempts of this key in the window", threadIds };
      const library = libraryEntries(input.projectId, area);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
      const round = `${HARNESS_DIR}-edit/${slug(area || "project")}__${slug(writerKey)}/${stamp}`;
      await runOnHost(host, { hostId: where.hostId, cwd: where.path, command: ensureExcludeLinesCommand([".lane-pilot/"]), timeoutSec: 30 }).catch(() => undefined);
      const base = evidenceFiles({ area, writerKey, attempts, harness: active.tree, library });
      const promptCtx = { area: area || "(whole project)", writerKey };
      await Promise.all(["inv", "dom"].map((label) => writeFiles(where, `${round}/${label}`, base)));
      const layout = evidenceLayout(base);
      const [inv, dom] = await Promise.all((["INV", "DOM"] as const).map((dim) => stage({
        projectId: input.projectId, where, folder: `${round}/${dim.toLowerCase()}`, cfg, fallback: active.tree,
        title: `Lane Pilot harness editor (${dim}): ${area || "project"} / ${writerKey}`, role: "harness-editor",
        mission: missionPointer(proposePrompt(dim, promptCtx), layout),
      })));
      threadIds.push(...inv.threadIds, ...dom.threadIds);
      for (const [label, result] of [["inv", inv], ["dom", dom]] as const) if (result.error) ctx.log(`harness ${key}: ${label} editor failed: ${result.error}`);
      if (inv.keptBase && dom.keptBase) {
        await bb.storage.kv.set(LAST_EDIT_KEY(input.projectId, area, writerKey), { at: Date.now(), result: "keep_base", notes: { inv: inv.notes, dom: dom.notes } } as never);
        return { status: "keep_base", detail: "both editors kept the current harness", threadIds };
      }
      const pool: PoolCandidate[] = [{ label: "inv", tree: inv.tree, diff: treeDiff(active.tree, inv.tree), notes: inv.notes }, { label: "dom", tree: dom.tree, diff: treeDiff(active.tree, dom.tree), notes: dom.notes }];
      const composeFiles = evidenceFiles({ area, writerKey, attempts, harness: active.tree, library, pool, decisions: { inv: inv.notes || inv.error || "", dom: dom.notes || dom.error || "" } });
      await writeFiles(where, `${round}/compose`, composeFiles);
      const composed = await stage({
        projectId: input.projectId, where, folder: `${round}/compose`, cfg, fallback: active.tree,
        title: `Lane Pilot harness composer: ${area || "project"} / ${writerKey}`, role: "harness-composer",
        mission: missionPointer(composePrompt(promptCtx, 2), evidenceLayout(composeFiles)),
      });
      threadIds.push(...composed.threadIds);
      if (composed.error) ctx.log(`harness ${key}: composer failed: ${composed.error}`);
      if (composed.keptBase) {
        await bb.storage.kv.set(LAST_EDIT_KEY(input.projectId, area, writerKey), { at: Date.now(), result: "keep_base", notes: { inv: inv.notes, dom: dom.notes, compose: composed.notes } } as never);
        return { status: "keep_base", detail: composed.error ? `composer failed (${composed.error}); the current harness stays` : "the composer kept the current harness", threadIds };
      }
      const candidate = insertHarness(db, { projectId: input.projectId, area, writerKey, tree: composed.tree, state: "trial", createdBy: "editor", parentId: active.id,
        notes: [`## inv\n${inv.notes}`, `## dom\n${dom.notes}`, `## compose\n${composed.notes}`].join("\n\n").slice(0, 20_000), reason: input.reason ?? null });
      await bb.storage.kv.set(LAST_EDIT_KEY(input.projectId, area, writerKey), { at: Date.now(), result: "trial", candidateId: candidate.id } as never);
      ctx.log(`harness ${key}: candidate ${candidate.id} on trial (${inventory(candidate.tree)}) from threads ${threadIds.join(", ")}`);
      ctx.realtime.notify(input.projectId, "harness");
      return { status: "trial", detail: inventory(candidate.tree), candidateId: candidate.id, threadIds };
    } catch (cause) {
      return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause), threadIds };
    } finally {
      running.delete(key);
    }
  }

  /** The trials of a project judged on their attempts; a decided trial gets its reflection. */
  async function evaluateTrials(projectId: string, options: { dryRun?: boolean; now?: number } = {}): Promise<Array<{ id: string; area: string; writerKey: string; decision: TrialDecision }>> {
    const cfg = await config(projectId);
    const now = options.now ?? Date.now();
    const out: Array<{ id: string; area: string; writerKey: string; decision: TrialDecision }> = [];
    for (const trial of listHarnesses(db, projectId, { states: ["trial"] })) {
      const rows = trialAttempts(db, trial);
      const decision = decideTrial(rows, trial.trialStartedAt ?? trial.createdAt, now, cfg.trial);
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

  /** After a trial decided: what each edit did, and the one lesson that transfers, into the library and the rules pipeline. */
  async function reflect(trialId: string): Promise<{ status: "done" | "skipped" | "failed"; detail: string }> {
    const trial = getHarness(db, trialId);
    if (!trial || !["adopted", "retired"].includes(trial.state)) return { status: "skipped", detail: "the trial has not decided" };
    const cfg = await config(trial.projectId);
    const where = await place(trial.projectId, trial.area);
    if (!where) return { status: "failed", detail: "no reachable folder for the reflection" };
    const parent = trial.parentId ? getHarness(db, trial.parentId) : null;
    const rows = trialAttempts(db, trial);
    const pick = (arm: "new" | "old") => rows.filter((row) => row.arm === arm).slice(-3).map((row) => row.attemptId);
    const attempts = await collectEvidence(trial.projectId, trial.area, trial.writerKey, 6, 0, { attemptIds: [...pick("new"), ...pick("old")] });
    const decision = decideTrial(rows, trial.trialStartedAt ?? trial.createdAt, Date.now(), cfg.trial);
    const files = evidenceFiles({
      area: trial.area, writerKey: trial.writerKey, attempts, harness: trial.tree, baseHarness: parent?.tree ?? {}, library: libraryEntries(trial.projectId, trial.area),
      pool: [{ label: "candidate", tree: trial.tree, diff: treeDiff(parent?.tree ?? {}, trial.tree), notes: trial.notes ?? "" }],
      decisions: { trial: `${trial.state}: ${trial.reason ?? ""}\n\n${JSON.stringify(decision.arms, null, 2)}`, editors: trial.notes ?? "" },
    });
    const folder = `${HARNESS_DIR}-edit/${slug(trial.area || "project")}__${slug(trial.writerKey)}/reflect-${trial.id}`;
    await writeFiles(where, folder, files);
    const result = await session({ projectId: trial.projectId, where, folder, cfg, harvest: false, role: "harness-reflection",
      title: `Lane Pilot harness reflection: ${trial.area || "project"} / ${trial.writerKey}`,
      mission: missionPointer(`${experiencePrompt({ area: trial.area || "(whole project)", writerKey: trial.writerKey })}\n\n# WHAT HAPPENED\n\nThe candidate (context/pool/candidate/, also context/harness/) was ${trial.state}: ${trial.reason ?? ""}. Attempts of both arms are under context/attempts/ (brief.md names the tree and arm). Compare context/harness/ with context/base_harness/.`, evidenceLayout(files)) });
    if (result.error) return { status: "failed", detail: result.error };
    const edits = parseEdits(result.text);
    const experience = parseExperience(result.text);
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
  async function tick(projectId: string, options: { dryRun?: boolean } = {}): Promise<{ trials: Awaited<ReturnType<typeof evaluateTrials>>; editors: Array<{ area: string; writerKey: string; attempts: number; result: string }> }> {
    const cfg = await config(projectId);
    const trials = await evaluateTrials(projectId, { dryRun: options.dryRun });
    const editors: Array<{ area: string; writerKey: string; attempts: number; result: string }> = [];
    if (!cfg.enabled) return { trials, editors };
    const since = Date.now() - cfg.windowDays * 86_400_000;
    let started = 0;
    for (const key of teachingKeys(db, projectId, since, cfg.minAttempts)) {
      if (started >= cfg.maxKeysPerNight || ctx.isDisposed()) break;
      if (trialHarness(db, projectId, key.area, key.writerKey)) { editors.push({ ...key, result: "trial running" }); continue; }
      const last = await bb.storage.kv.get(LAST_EDIT_KEY(projectId, key.area, key.writerKey)).catch(() => null) as { at?: number } | null;
      if (last?.at && Date.now() - last.at < cfg.windowDays * 86_400_000) { editors.push({ ...key, result: "edited recently" }); continue; }
      if (options.dryRun) { editors.push({ ...key, result: "would start an editor" }); started++; continue; }
      const result = await runEditor({ projectId, area: key.area, writerKey: key.writerKey, reason: `nightly: ${key.attempts} attempts in ${cfg.windowDays} days` });
      editors.push({ ...key, result: `${result.status}: ${result.detail}` });
      started++;
    }
    return { trials, editors };
  }

  async function status(projectId: string) {
    const cfg = await config(projectId);
    const trees = listHarnesses(db, projectId, { states: ["base", "adopted", "trial"] });
    const trials = trees.filter((row) => row.state === "trial").map((row) => ({ id: row.id, area: row.area, writerKey: row.writerKey, since: row.trialStartedAt, decision: decideTrial(trialAttempts(db, row), row.trialStartedAt ?? row.createdAt, Date.now(), cfg.trial) }));
    const recent = listHarnesses(db, projectId, { states: ["retired"] }).slice(0, 10).map((row) => ({ id: row.id, area: row.area, writerKey: row.writerKey, reason: row.reason, decidedAt: row.decidedAt }));
    return {
      config: cfg,
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
      const result = await tick(projectId).catch((cause) => { ctx.log(`harness nightly for ${projectId} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (result) bb.log.info(`Lane Pilot harness nightly ${projectId}: ${result.trials.length} trials judged, editors: ${result.editors.map((row) => `${row.area || "project"}/${row.writerKey}=${row.result}`).join("; ") || "none"}`);
    }
  }, { timeoutMs: 5 * 3_600_000 });

  return { config, setConfig, forAttempt, materialize, checksForAttempt, checksForWriterThread, runEditor, evaluateTrials, reflect, tick, status, trajectory };
}

export type HarnessApi = ReturnType<typeof createHarness>;
