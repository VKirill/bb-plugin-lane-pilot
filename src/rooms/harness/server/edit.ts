import { runOnHost } from "@lane-pilot/host-calls";
import {
  HarnessValidationError, LANE_PILOT_SURFACE, composePrompt, fingerprint, inventory, proposePrompt, screenRejected, validate,
  type RejectedEdit, type Tree,
} from "@lane-pilot/harness-core";
import { type ServerCore } from "../../contracts/server";
import { ensureExcludeLinesCommand } from "../../verification";
import { getTaskGitBase } from "../../storage";
import { wfTerminalByIdemKey } from "@lane-pilot/workflow-engine";
import type { ChainRuntime } from "../../contracts/server";
import type { HostPort } from "../../bench/server";
import { evidenceFiles, evidenceLayout, treeDiff, type AttemptEvidence, type LibraryEntry, type PoolCandidate } from "./evidence";
import { ANY_WRITER, activeHarness, insertHarness, listHarnesses, trialHarness } from "./store";
import { graphEditProblems } from "./graph-edit";
import { formatProbeReplays, runHarnessProbe } from "./probe-run";
import { HARNESS_DIR, harnessMission, slug } from "./parts";
import { LAST_EDIT_KEY, type HarnessConfig } from "./config";
import { HARNESS_EDIT_WORKFLOW, HARNESS_TUNING, type HarnessStep, type Services } from "./contract";
import type { createSessions } from "./sessions";

type Deps = {
  config: (projectId: string) => Promise<HarnessConfig>;
  place: ReturnType<typeof createSessions>["place"];
  writeFiles: ReturnType<typeof createSessions>["writeFiles"];
  stage: ReturnType<typeof createSessions>["stage"];
  collectEvidence: (projectId: string, area: string, writerKey: string, limit: number, sinceMs: number, filter?: { attemptIds?: string[] }) => Promise<AttemptEvidence[]>;
  libraryEntries: (projectId: string, area: string) => LibraryEntry[];
  running: Set<string>;
};

/** One improvement round for a key: `lp.harness-edit`'s prepare, edit (two editors, probe, composer) and validate, and the manual `runEditor`. */
export function createEdit(ctx: ServerCore, services: Services, deps: Deps) {
  const { bb, db, host } = ctx;
  const { config, place, writeFiles, stage, collectEvidence, libraryEntries, running } = deps;

  /** Retired trees of this key, with the reason they were refused. The editor reads them; an identical fingerprint is not trialled again. */
  function rejectedFor(projectId: string, area: string, writerKey: string): RejectedEdit[] {
    return listHarnesses(db, projectId, { area, writerKey, states: ["retired"] })
      .filter((row) => row.reason?.trim())
      .map((row) => ({ fingerprint: row.fingerprint, reason: row.reason!.trim(), summary: inventory(row.tree) }));
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

  async function editRound(step: HarnessStep, input: { projectId: string; area: string; writerKey: string; where: { hostId: string; path: string }; stamp: string }): Promise<Record<string, unknown>> {
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
      mission: harnessMission(proposePrompt(dim, promptCtx, rejected), layout), surface,
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
      mission: harnessMission(composePrompt(promptCtx, 2), evidenceLayout(composeFiles)), surface,
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
    const prior = wfTerminalByIdemKey(db as never, runKey);
    if (prior && TERMINAL_RUN.includes(prior.status)) return { status: "skipped", detail: "the round of this night already ran", threadIds: [] };
    const workflow = services.workflowEngine.resolveWorkflow(HARNESS_EDIT_WORKFLOW);
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

  return { prepareEdit, editRound, validateEdit, runEditor };
}
