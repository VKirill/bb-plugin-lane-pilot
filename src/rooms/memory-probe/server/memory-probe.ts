import { randomBytes } from "node:crypto";
import { getRuleProposal, upsertLessonProposal } from "@lane-pilot/run-insights";
import { storeMemoryRecords, type MemoryKind, type MemorySettings } from "@lane-pilot/memory-core";
import { sha256Hex } from "@lane-pilot/kit";
import { taskV2Schema, type TaskV2 } from "../../contracts";
import { MEMORY_PATHS, pathById, type MemoryPath, type ProbeKind } from "../../memory";
import { pmMemoryContext, reviewerMemoryFor, sessionMemoryRpc, taskMemoryContext } from "../../memory/server";
import { stickyTurnPromptWithRules, writerBriefSegments, writerContextBlocks, writerKnowledge } from "../../writer/server";
import { memoryUnanswered, pmResumeInstructions, pmRulesOf, pmRulesPromptBlock, ruleBudget, type MemoryUnanswered } from "../../learning";
import { codeCritiquePrompt, codeRepairPrompt } from "../../critique";
import { nightReviewPrompt } from "../../night";
import { councilMemoryBlock } from "../../council/server";
import { adoptRuleProposal, deleteMemoryRecord, memorySettingsFor, retireAdoptedRule } from "../../self-repair/server";
import { HARNESS_VERSION, loadPrototypeConfig } from "../../storage";
import { DRILL_SANDBOX_PROJECT_IDS } from "../../stability/server";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";

/**
 * The memory probe (SMA block 4, P0-3): does the memory the project holds reach the agent of each delivery path?
 *
 * It writes three records through the one write door (`storeMemoryRecords`, and the lesson door for the rule) that carry a unique
 * token: a note that names a folder (`PROBE_ANCHOR`), a core convention, and an always-on rule; each lives a day at most and is taken
 * out when the probe ends. Then, for every path of `MEMORY_PATHS` that is `probed`, it builds what that path's agent is handed, with
 * the same functions production calls (the registry's sites), and looks for the tokens in the text. A path passes when every kind it
 * `carries` is found. The negative case runs a task or a query that has nothing to do with the probe: a kind the path does not hand
 * to every task by design (`alwaysOn`) must not appear, and a query of gibberish must pull no record at all.
 *
 * The probe never starts a model. The real thing — the first prompt of a real writer and of a real PM in their thread logs, a real
 * `lane-memory` in a terminal — is read by the drill scenario `memory_paths` (scripts/lp-drill.py) after `--keep`.
 */
export const PROBE_ANCHOR = "lp-probe/memory";
const PROBE_TTL_MS = 24 * 3_600_000;
const GIBBERISH = "zqxjvk wkpqzt";
/** Projects the probe may write to without `force`: the drill sandboxes. */
const sandboxProjects = () => new Set([...DRILL_SANDBOX_PROJECT_IDS, ...(process.env.LP_MEMORY_PROBE_PROJECTS ?? "").split(",").map((item) => item.trim()).filter(Boolean)]);

export type MemoryProbeRow = { path: string; found: boolean; negativeOk: boolean | null; latencyMs: number; detail: string };
export type MemoryProbeReport = {
  ok: boolean; projectId: string; token: string; anchor: string; lpVersion: string; at: number; kept: boolean;
  tokens: Record<ProbeKind, string>; planted: Record<ProbeKind, boolean>;
  results: MemoryProbeRow[]; skipped: Array<{ path: string; reason: string }>; problems: string[];
  /** Owner repeats and routable questions of the last 30 days: the questions memory did not answer. */
  unanswered: MemoryUnanswered;
};

type Probe = {
  delivered: string;
  /** The same path for a task or a query that has nothing to do with the probe; null when there is no such case. */
  negative: string | null;
  /** Records the gibberish query pulled. */
  pulled?: number;
};
type Context = {
  db: ServerCore["db"]; host: ServerCore["host"]; services: Services; ctx: ServerCore; projectId: string; hostId: string; settings: MemorySettings;
  positive: TaskV2; unrelated: TaskV2; query: string;
};

const probeTask = (id: string, title: string, dir: string, cwd: string): TaskV2 => taskV2Schema.parse({
  schema_version: 2, id, title, risk: "low", lane: "writer", project_cwd: cwd, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: [`${dir}/file.txt`], owns_paths: [`${dir}/file.txt`], never_touch: [], depends_on: [], objective: title,
  acceptance: [`${dir}/file.txt exists`], verify: "none", verification: [],
});

const lines = (value: readonly string[]) => value.join("\n");

/** What each probed path hands its agent, built by the code the path runs in production. */
const PROBES: Record<string, (c: Context) => Promise<Probe> | Probe> = {
  "writer.brief": async (c) => {
    const build = async (task: TaskV2) => {
      const known = await writerKnowledge({ db: c.db, host: c.host, chainForRun: async () => [] }, { projectId: c.projectId, runId: "memory-probe", hostId: c.hostId, task, memorySettings: c.settings });
      return writerBriefSegments(task, known.mixed.text, "", undefined, "Lane Pilot writer", "", known.rulesText).map((segment) => segment.text).join("\n\n");
    };
    return { delivered: await build(c.positive), negative: await build(c.unrelated) };
  },
  "writer.turn": async (c) => {
    const build = async (task: TaskV2) => (await stickyTurnPromptWithRules({ db: c.db, host: c.host, chainForRun: async () => [] },
      { projectId: c.projectId, runId: "memory-probe", hostId: c.hostId, task, memorySettings: c.settings }, { kind: "next-task", task }))([]);
    return { delivered: await build(c.positive), negative: await build(c.unrelated) };
  },
  "writer.repair": async (c) => {
    const build = async (task: TaskV2) => {
      const known = await writerKnowledge({ db: c.db, host: c.host, chainForRun: async () => [] }, { projectId: c.projectId, runId: "memory-probe", hostId: c.hostId, task, memorySettings: c.settings });
      return codeRepairPrompt({ task, findings: [], contextBlocks: writerContextBlocks(task, known.mixed.text, "", "", known.rulesText) });
    };
    return { delivered: await build(c.positive), negative: await build(c.unrelated) };
  },
  "pm.start": (c) => {
    const text = pmRulesPromptBlock(c.db, c.projectId, [], ruleBudget("pm"));
    return { delivered: text, negative: text };
  },
  "pm.resume": (c) => {
    const text = pmResumeInstructions(c.db, c.projectId, []) ?? "";
    return { delivered: text, negative: text };
  },
  "pm.rules_tool": (c) => {
    const text = lines(pmRulesOf(c.db, c.projectId).map((rule) => rule.rule));
    return { delivered: text, negative: text };
  },
  "pm.memory_tool": (c) => {
    const none = pmMemoryContext(c.db, c.projectId, c.settings, GIBBERISH);
    return { delivered: pmMemoryContext(c.db, c.projectId, c.settings, c.query).text, negative: none.text, pulled: none.records.length };
  },
  "schedule.agent": (c) => ({ delivered: taskMemoryContext(c.db, c.projectId, null, c.query), negative: taskMemoryContext(c.db, c.projectId, null, GIBBERISH) }),
  "critic.code": (c) => {
    const build = (task: TaskV2) => codeCritiquePrompt({ evidence: {} as never, task, memoryText: reviewerMemoryFor(c.db, c.projectId, null, task) });
    return { delivered: build(c.positive), negative: build(c.unrelated) };
  },
  "night.review": (c) => {
    const build = (task: TaskV2) => nightReviewPrompt({ agent: "night reviewer", task, acceptedResult: {}, workspace: "/tmp/memory-probe", maxFindings: 5, memoryText: reviewerMemoryFor(c.db, c.projectId, null, task) });
    return { delivered: build(c.positive), negative: build(c.unrelated) };
  },
  "council.evidence": (c) => {
    const none = councilMemoryBlock(c.db, c.projectId, GIBBERISH);
    return { delivered: councilMemoryBlock(c.db, c.projectId, c.query), negative: none, pulled: none ? 1 : 0 };
  },
  "terminal.search": async (c) => {
    const rpc = sessionMemoryRpc(c.ctx, c.services);
    const found = await rpc.session_memory_search({ projectId: c.projectId, query: c.query });
    const none = await rpc.session_memory_search({ projectId: c.projectId, query: GIBBERISH });
    return { delivered: lines(found.records.map((row) => row.content)), negative: lines(none.records.map((row) => row.content)), pulled: none.records.length };
  },
  "terminal.core": async (c) => ({ delivered: lines((await sessionMemoryRpc(c.ctx, c.services).session_memory_core({ projectId: c.projectId })).records.map((row) => row.content)), negative: null }),
};

export function createMemoryProbe(ctx: ServerCore, services: Services) {
  const { db, host } = ctx;

  /** Removes what an earlier probe left (a crashed run, a `--keep`): the records of origin `probe` and the probe's rules. */
  function clean(projectId: string): number {
    let removed = 0;
    for (const row of db.prepare("SELECT id FROM lane_pilot_memory WHERE project_id=? AND origin='probe'").all(projectId) as Array<{ id: string }>) { deleteMemoryRecord(db, projectId, row.id); removed++; }
    for (const row of db.prepare("SELECT id FROM lane_pilot_rule_proposal WHERE project_id=? AND state='accepted' AND rule LIKE 'Probe rule lpprobe%'").all(projectId) as Array<{ id: string }>) { retireAdoptedRule(db, projectId, row.id, "memory probe finished"); removed++; }
    return removed;
  }

  async function run(input: { projectId: string; paths?: readonly string[]; keep?: boolean; force?: boolean }): Promise<MemoryProbeReport> {
    const { projectId } = input;
    if (!input.force && !sandboxProjects().has(projectId)) throw new Error(`memory-probe writes records: ${projectId} is not a sandbox project (${[...sandboxProjects()].join(", ")}); pass force=1 to probe another one`);
    const unknown = (input.paths ?? []).filter((id) => !pathById(id));
    if (unknown.length) throw new Error(`unknown memory path: ${unknown.join(", ")}; known: ${MEMORY_PATHS.map((entry) => entry.id).join(", ")}`);
    const selected = MEMORY_PATHS.filter((entry) => !input.paths?.length || input.paths.includes(entry.id));
    const at = Date.now();
    const hex = randomBytes(4).toString("hex");
    const tokens: Record<ProbeKind, string> = { note: `lpprobe${hex}n`, core: `lpprobe${hex}c`, rule: `lpprobe${hex}r` };
    const planted: Record<ProbeKind, boolean> = { note: false, core: false, rule: false };
    const problems: string[] = [];
    const settings = memorySettingsFor(db, projectId);
    const config = loadPrototypeConfig(db, projectId);
    const cwd = config?.writerWorkspacePath?.startsWith("/") ? config.writerWorkspacePath : "/tmp/memory-probe";
    clean(projectId);

    // The one write door: the same function the maintainer, the session RPC and the rules use. Trusted (confirmed), so writers read it at once.
    const plant = (kind: MemoryKind, content: string, concepts: string[]) => storeMemoryRecords(db, {
      projectId, personalBot: settings.personalBot, audience: "subagent", sourceSha256: sha256Hex(`probe:${hex}`), trust: "confirmed", origin: "probe",
      entries: [{ kind, content, concepts, validUntil: at + PROBE_TTL_MS }],
      coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget,
    });
    try { planted.note = plant("note", `Probe note ${tokens.note}: the folder ${PROBE_ANCHOR} holds a memory delivery check. Nothing to do; it deletes itself within a day.`, ["lp-probe", "probe"]).insertedIds.length > 0; }
    catch (cause) { problems.push(`note not written: ${cause instanceof Error ? cause.message : String(cause)}`); }
    try { planted.core = plant("core", `Probe core ${tokens.core}: lp-probe memory delivery check convention. Nothing to do; it deletes itself within a day.`, ["lp-probe", "probe"]).insertedIds.length > 0; }
    catch (cause) { problems.push(`core not written: ${cause instanceof Error ? cause.message : String(cause)}`); }
    try {
      const lesson = upsertLessonProposal(db, projectId, { rule: `Probe rule ${tokens.rule}: lp-probe memory delivery check, nothing to do.`, evidence: "memory probe", audience: "both", always: true });
      adoptRuleProposal(db, projectId, lesson.id);
      planted.rule = getRuleProposal(db, projectId, lesson.id)?.state === "accepted";
      if (!planted.rule) problems.push("rule not adopted (its pool has no room); see the rule journal");
    } catch (cause) { problems.push(`rule not written: ${cause instanceof Error ? cause.message : String(cause)}`); }

    const c: Context = { db, host, services, ctx, projectId, hostId: config?.hostId ?? "local", settings,
      positive: probeTask("memory-probe-a", "Memory probe task about the probe folder", PROBE_ANCHOR, cwd),
      unrelated: probeTask("memory-probe-b", "Memory probe task about colour themes", "zz-other/unrelated", cwd),
      query: "memory delivery check lp-probe" };
    const results: MemoryProbeRow[] = [], skipped: Array<{ path: string; reason: string }> = [];
    try {
      for (const entry of selected) {
        if (entry.status === "exempt") { skipped.push({ path: entry.id, reason: entry.reason ?? "exempt" }); continue; }
        const probe = PROBES[entry.id];
        if (!probe) { problems.push(`${entry.id}: no probe implemented`); results.push({ path: entry.id, found: false, negativeOk: null, latencyMs: 0, detail: "no probe implemented for this registered path" }); continue; }
        const began = Date.now();
        let row: MemoryProbeRow;
        try { row = judge(entry, await probe(c), tokens, Date.now() - began); }
        catch (cause) { row = { path: entry.id, found: false, negativeOk: null, latencyMs: Date.now() - began, detail: `probe failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 400) }; }
        results.push(row);
      }
    } finally {
      if (!input.keep) clean(projectId);
    }
    const insert = db.prepare("INSERT INTO lane_pilot_memory_probe(at,project_id,token,path,found,negative_ok,latency_ms,lp_version,detail) VALUES(?,?,?,?,?,?,?,?,?)");
    for (const row of results) insert.run(at, projectId, hex, row.path, row.found ? 1 : 0, row.negativeOk === null ? null : row.negativeOk ? 1 : 0, row.latencyMs, HARNESS_VERSION, row.detail);
    const ok = problems.length === 0 && results.length > 0 && results.every((row) => row.found && row.negativeOk !== false);
    return { ok, projectId, token: hex, anchor: PROBE_ANCHOR, lpVersion: HARNESS_VERSION, at, kept: Boolean(input.keep), tokens, planted, results, skipped, problems,
      unanswered: memoryUnanswered(db, projectId) };
  }

  /** The last run per path, with the unanswered-questions counts: what `memory-probe <project> --report` prints. */
  function report(projectId: string) {
    const rows = db.prepare(`SELECT path, found, negative_ok AS negativeOk, latency_ms AS latencyMs, lp_version AS lpVersion, at, detail FROM lane_pilot_memory_probe
      WHERE project_id=? AND at=(SELECT max(at) FROM lane_pilot_memory_probe WHERE project_id=?) ORDER BY path`).all(projectId, projectId) as Array<{ path: string; found: number; negativeOk: number | null; latencyMs: number; lpVersion: string; at: number; detail: string }>;
    return { projectId, results: rows.map((row) => ({ ...row, found: row.found === 1, negativeOk: row.negativeOk === null ? null : row.negativeOk === 1 })), unanswered: memoryUnanswered(db, projectId) };
  }

  return { run, clean, report };
}

/** Found: every kind the path carries is in the text. Negative: no kind outside `alwaysOn` in the unrelated case, and nothing pulled by a gibberish query. */
export function judge(entry: MemoryPath, probe: Probe, tokens: Record<ProbeKind, string>, latencyMs: number): MemoryProbeRow {
  const missing = entry.carries.filter((kind) => !probe.delivered.includes(tokens[kind]));
  const stray = probe.negative === null ? [] : (["note", "core", "rule"] as const).filter((kind) => !entry.alwaysOn.includes(kind) && probe.negative!.includes(tokens[kind]));
  const negativeOk = probe.negative === null ? null : stray.length === 0 && (probe.pulled ?? 0) === 0;
  const detail = [
    `carries ${entry.carries.join("+")}: ${missing.length ? `MISSING ${missing.join("+")}` : "all found"}`,
    `${probe.delivered.length} chars`,
    ...(negativeOk === false ? [`negative case pulled ${stray.length ? stray.join("+") : `${probe.pulled} record(s)`}`] : []),
  ].join("; ");
  return { path: entry.id, found: missing.length === 0, negativeOk, latencyMs, detail };
}

