import { randomBytes } from "node:crypto";
import { deleteMemoryRecord, latestMemoryProbeRows, listMemoryIdsByOrigin, otherMemoryProjectId, recordMemoryProbe, storeMemoryRecords, type MemoryKind, type MemorySettings } from "@lane-pilot/memory-core";
import { sha256Hex } from "@lane-pilot/kit";
import { DRILL_SANDBOX_PROJECT_IDS, taskV2Schema, type TaskV2 } from "../../../contracts";
import { MEMORY_PATHS, pathById, type ProbeKind } from "../../../memory";
import { memorySettingsFor, pmMemoryContext, reviewerMemoryFor, taskMemoryContext, threadMemoryBlock } from "../../../memory/server";
import { writerBriefSegments, writerContextBlocks, writerKnowledge } from "../../../writer/server";
import { codeCritiquePrompt, codeRepairPrompt } from "../../../critique";
import { HARNESS_VERSION, loadProjectSettings, loadPrototypeConfig } from "../../../storage";
import type { ServerCore } from "../../../contracts/server";
import { PROBE_ANCHOR, judge, type MemoryProbeReport, type MemoryProbeRow, type Probe } from "../../models/probe";

/**
 * The memory probe (SMA block 4, P0-3): does the memory the project holds reach the agent of each delivery path?
 *
 * It writes two records through the one write door (`storeMemoryRecords`) that carry a unique token: a note that
 * names a folder (`PROBE_ANCHOR`) and a core convention; each lives a day at most and is taken out when the probe
 * ends. Then, for every path of `MEMORY_PATHS` that is `probed`, it builds what that path's agent is handed, with
 * the same functions production calls, and looks for the tokens in the text.
 */
const PROBE_TTL_MS = 24 * 3_600_000;
const GIBBERISH = "zqxjvk wkpqzt";
/** Projects the probe may write to without `force`: the drill sandboxes. */
const sandboxProjects = () => new Set([...DRILL_SANDBOX_PROJECT_IDS, ...(process.env.LP_MEMORY_PROBE_PROJECTS ?? "").split(",").map((item) => item.trim()).filter(Boolean)]);

type Context = {
  db: ServerCore["db"]; host: ServerCore["host"]; ctx: ServerCore; projectId: string; hostId: string; settings: MemorySettings;
  positive: TaskV2; unrelated: TaskV2; query: string;
};

const probeTask = (id: string, title: string, dir: string, cwd: string): TaskV2 => taskV2Schema.parse({
  schema_version: 2, id, title, risk: "low", lane: "writer", project_cwd: cwd, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: [`${dir}/file.txt`], owns_paths: [`${dir}/file.txt`], never_touch: [], depends_on: [], objective: title,
  acceptance: [`${dir}/file.txt exists`], verify: "none", verification: [],
});

/** What each probed path hands its agent, built by the code the path runs in production. */
const PROBES: Record<string, (c: Context) => Promise<Probe> | Probe> = {
  "writer.brief": async (c) => {
    storeMemoryRecords(c.db, {
      projectId: c.projectId, audience: "subagent", sourceSha256: sha256Hex("probe:sibling"), trust: "confirmed", origin: "probe",
      entries: [{ kind: "note", content: "Sibling section only: the other port is 4000.", concepts: ["lp-probe"] }],
      coreBudget: c.settings.coreBudget, noteBudget: c.settings.noteBudget, indexBudget: c.settings.indexBudget, scope: ["section:other"],
    });
    const build = async (task: TaskV2) => {
      const known = await writerKnowledge({ db: c.db, host: c.host, chainForRun: async () => ["section:probe"], log: c.ctx.log }, { projectId: c.projectId, runId: "memory-probe", hostId: c.hostId, task, memorySettings: c.settings });
      return writerBriefSegments(task, known.mixed.text, "", undefined, "Lane Pilot writer", "").map((segment) => segment.text).join("\n\n");
    };
    const delivered = await build(c.positive);
    if (delivered.includes("other port is 4000")) throw new Error("sibling section leaked into the writer brief");
    return { delivered, negative: await build(c.unrelated) };
  },
  "writer.repair": async (c) => {
    const build = async (task: TaskV2) => {
      const known = await writerKnowledge({ db: c.db, host: c.host, chainForRun: async () => ["section:probe"], log: c.ctx.log }, { projectId: c.projectId, runId: "memory-probe", hostId: c.hostId, task, memorySettings: c.settings });
      return codeRepairPrompt({ task, findings: [], contextBlocks: writerContextBlocks(task, known.mixed.text, "", "") });
    };
    return { delivered: await build(c.positive), negative: await build(c.unrelated) };
  },
  // A thread id no plugin table recorded is an ordinary thread; the negative asks the same thread id of another project.
  "bb.thread": (c) => {
    const other = otherMemoryProjectId(c.db, c.projectId) ?? "memory-probe-none";
    return { delivered: threadMemoryBlock(c.db, { projectId: c.projectId, threadId: "memory-probe-thread" }) ?? "",
      negative: threadMemoryBlock(c.db, { projectId: other, threadId: "memory-probe-thread" }) ?? "" };
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
};

export function createMemoryProbe(ctx: ServerCore) {
  const { db, host } = ctx;

  /**
   * Removes what an earlier probe left (a crashed run, a `--keep`): the records of origin `probe` and the notes
   * the writers of earlier drills saved about the probe folder (`bb lane-pilot memory write`, origin `session`).
   */
  function clean(projectId: string): number {
    let removed = 0;
    for (const id of [...listMemoryIdsByOrigin(db, projectId, "probe"), ...listMemoryIdsByOrigin(db, projectId, "session", PROBE_ANCHOR)]) {
      deleteMemoryRecord(db, projectId, id);
      removed++;
    }
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
    const tokens: Record<ProbeKind, string> = { note: `lpprobe${hex}n`, core: `lpprobe${hex}c` };
    const planted: Record<ProbeKind, boolean> = { note: false, core: false };
    const problems: string[] = [];
    const settings = memorySettingsFor(loadProjectSettings(db, projectId));
    const config = loadPrototypeConfig(db, projectId);
    const cwd = config?.writerWorkspacePath?.startsWith("/") ? config.writerWorkspacePath : "/tmp/memory-probe";
    clean(projectId);

    const plant = (kind: MemoryKind, content: string, concepts: string[]) => storeMemoryRecords(db, {
      projectId, personalBot: settings.personalBot, audience: "subagent", sourceSha256: sha256Hex(`probe:${hex}`), trust: "confirmed", origin: "probe",
      entries: [{ kind, content, concepts, validUntil: at + PROBE_TTL_MS }],
      coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget,
    });
    try { planted.note = plant("note", `Probe note ${tokens.note}: the folder ${PROBE_ANCHOR} holds a memory delivery check. Nothing to do; it deletes itself within a day.`, ["lp-probe", "probe"]).insertedIds.length > 0; }
    catch (cause) { problems.push(`note not written: ${cause instanceof Error ? cause.message : String(cause)}`); }
    try { planted.core = plant("core", `Convention ${tokens.core}: writers of this project keep one port per service.`, ["lp-probe", "probe"]).insertedIds.length > 0; }
    catch (cause) { problems.push(`core not written: ${cause instanceof Error ? cause.message : String(cause)}`); }

    const c: Context = { db, host, ctx, projectId, hostId: config?.hostId ?? "local", settings,
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
    for (const row of results) recordMemoryProbe(db, { at, projectId, token: hex, path: row.path, found: row.found, negativeOk: row.negativeOk, latencyMs: row.latencyMs, lpVersion: HARNESS_VERSION, detail: row.detail });
    const ok = problems.length === 0 && results.length > 0 && results.every((row) => row.found && row.negativeOk !== false);
    return { ok, projectId, token: hex, anchor: PROBE_ANCHOR, lpVersion: HARNESS_VERSION, at, kept: Boolean(input.keep), tokens, planted, results, skipped, problems };
  }

  /** The last run per path: what `memory-probe <project> --report` prints. */
  function report(projectId: string) {
    const rows = latestMemoryProbeRows(db, projectId);
    return { projectId, results: rows.map((row) => ({ ...row, found: row.found === 1, negativeOk: row.negativeOk === null ? null : row.negativeOk === 1 })) };
  }

  return { run, clean, report };
}

export type MemoryProbeApi = ReturnType<typeof createMemoryProbe>;
