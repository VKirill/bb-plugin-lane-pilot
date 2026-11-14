import { noteEngineWrite } from "../../verification/server";
import { getRun, getRunWriterHost, listRunTaskRows } from "../../storage";
import { cycleText, dependsOnTask, planGraph } from "../../tasks";
import { bestEffort, sha256Hex } from "@lane-pilot/kit";
import { list, rec, str, pmCheckout, quote, needLanePilot } from "./workflow-chain-runtime";
import type { Row } from "./workflow-chain-runtime";
import type { TaskV2 } from "../../contracts";
import { validateTaskV2 } from "./workflow-lp-task";
import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { runOnHost } from "@lane-pilot/host-calls";
import { hostContract } from "../../contracts";
import { withTaskStandard } from "./workflow-task-contract";
import { QUICK_STATE_PATH, quickStateEdit, debugSessionSlug, debugSessionDoc } from "./workflow-planning-files";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import type { createTaskLinter } from "../../tasks/server";

type Action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;
type PlanHome = (projectId: string, checkout: { hostId: string; path: string }) => Promise<string | null>;

/** The task bookkeeping of a chain: the plan's contract lint, the quick path's STATE.md row, and the debug session file. */
export function registerTaskBookActions(engine: WorkflowEngine, ctx: ServerCore, deps: {
  action: Action;
  planHome: PlanHome;
  lintTask: ReturnType<typeof createTaskLinter>;
}): void {
  const { bb, db } = ctx;
  const { action, planHome, lintTask } = deps;

  action("lp.lint_contract", async (c, lane) => {
    const rt = needLanePilot(lane, "lp.lint_contract");
    const tasks = list(c.resolve("plan.tasks"));
    const waves = list(c.resolve("plan.waves")).map((wave) => list(wave).map(String));
    const run = getRun(db, rt.runId);
    const hostId = getRunWriterHost(db, rt.runId) ?? "";
    const errors: string[] = [];
    const parsed: TaskV2[] = [];
    for (const [at, raw] of tasks.entries()) {
      const valid = validateTaskV2({ ...withTaskStandard(rec(raw), str(rec(raw).id) || `task-${at + 1}`), project_cwd: run?.writer_workspace_path ?? str(rec(raw).project_cwd) });
      if (!valid.ok) { errors.push(`task #${at + 1} (${str(rec(raw).id) || "no id"}): ${valid.errors.join("; ")}`); continue; }
      parsed.push(valid.task);
      if (run?.writer_workspace_path) {
        const lint = await bestEffort(rt.ctx.log, "workflow task lint", lintTask(rt.projectId, rt.runId, valid.task, run.writer_workspace_path, hostId, "workflow"), null);
        for (const error of lint?.errors ?? []) errors.push(`${valid.task.id}: ${error.message}`);
      }
    }
    // The waves are laid out from depends_on by code (SMA bf_waves): the planner's own `waves` are replaced, not trusted — a wave it
    // wrote later than its links allow would hold a task back for nothing, an earlier one would start it before its dependency.
    const graph = planGraph(parsed);
    // A plan whose waves cannot be computed is not issued (SMA p2_waves): a cycle goes back to the planner before any dispatch.
    if (graph.cycle) errors.push(`the tasks depend on each other in a cycle (${cycleText(graph.cycle)}): no wave can be computed; drop the depends_on that is not a real output dependency`);
    // A dependency resolves inside the run: a task of this plan, or one already dispatched in this run.
    const runTasks = listRunTaskRows(db, rt.runId).map((row) => row.id);
    for (const [id, dep] of graph.unknown) {
      if (!runTasks.some((task) => dependsOnTask([dep], task))) errors.push(`${id}: depends_on ${dep} names no task of this plan or run`);
    }
    // Tasks of one computed wave run together: their owned paths must not meet — a task that must follow another names it in depends_on.
    const own = (task: TaskV2) => task.owns_paths.map((path) => path.replace(/\/?\*+.*$/, "").replace(/\/$/, ""));
    for (const wave of graph.waves) {
      const members = parsed.filter((task) => wave.includes(task.id));
      for (const [i, a] of members.entries()) for (const b of members.slice(i + 1)) {
        const clash = own(a).find((x) => own(b).some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
        if (clash !== undefined) errors.push(`${a.id} and ${b.id} run in the same wave (neither depends on the other) but both own ${clash || "the repository root"}: add a depends_on between them or split the paths`);
      }
    }
    const written = JSON.stringify(waves.filter((wave) => wave.length));
    if (graph.waves.length && waves.length && written !== JSON.stringify(graph.waves)) rt.ctx.log(`lp.lint_contract: the planner's waves ${written.slice(0, 300)} were replaced by the waves of depends_on ${JSON.stringify(graph.waves).slice(0, 300)}`);
    // An empty plan is right when the planner checked that the repository already does what the goal asks (already_met).
    if (!tasks.length && c.resolve("plan.already_met") !== true) errors.push("the plan has no tasks");
    return { ok: errors.length === 0, errors, waves: graph.waves };
  });

  // The quick path's row in STATE.md (SMA k_wq_state): the task joins the «Quick Tasks Completed» table of
  // .agents/planning/STATE.md on the writer host and is committed — only where that file already exists (it is never created);
  // a failed write is returned, never thrown — a closed task does not reopen for a bookkeeping write.
  action("lp.quick_state", async (c, lane) => {
    const rt = needLanePilot(lane, "lp.quick_state");
    const comment = str((c.input.with as Row | undefined)?.comment ?? c.resolve("review.comment")) || "quick path: built and verified";
    const run = getRun(db, rt.runId);
    const hostId = getRunWriterHost(db, rt.runId);
    if (!run?.writer_workspace_path || !hostId) return { ok: false, note: "no writer workspace", comment };
    // The planning home holds STATE.md when one is set (SMA d_project_planning); its row and its commit go there too.
    const root = (await planHome(rt.projectId, { hostId, path: run.writer_workspace_path })) ?? run.writer_workspace_path;
    const read = await runOnHost(ctx.host, { hostId, cwd: root, command: `if [ -f ${QUICK_STATE_PATH} ]; then cat ${QUICK_STATE_PATH}; else exit 3; fi`, timeoutSec: 20, timeoutMs: 30_000 });
    const title = str((c.input.with as Row | undefined)?.title ?? c.resolve("$inputs.title")) || "quick task";
    const commit = list((c.input.with as Row | undefined)?.commits ?? c.resolve("ctx.merged_commits")).map(String)[0] ?? "—";
    const edit = quickStateEdit(read, { date: new Date().toISOString().slice(0, 10), task: title.slice(0, 120), commit });
    if (!edit) return { ok: true, note: "no STATE.md in the project: nothing written", comment };
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const path = QUICK_STATE_PATH;
    try {
      const edits = [{ path, expectedSha256: edit.expectedSha256, content: edit.content }];
      const written = await host.call("writePhaseBook", { requestedHostId: hostId, projectCwd: root, previewSha256: sha256Hex(JSON.stringify(edits)), edits }, { hostId, timeoutMs: 30_000 });
      if (!written.writes.some((row) => row.path === path && row.status === "applied")) throw new Error(written.writes.find((row) => row.path === path)?.status ?? "not applied");
      const committed = await bestEffort(ctx.log, "quick STATE.md commit", host.call("gitCommitDocs", { requestedHostId: hostId, projectCwd: root, paths: [path], message: `state: quick task done — ${title.replace(/\s+/g, " ").trim().slice(0, 60)}` }, { hostId, timeoutMs: 60_000 }), null);
      return { ok: true, note: committed?.commit ? "" : "row written, not committed", comment };
    } catch (cause) {
      return { ok: false, note: `STATE.md write failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300), comment };
    }
  });

  // The debug session file of an investigation (SMA k_pl_debug): `.agents/planning/debug/<slug>.md` — an existing one is
  // resumed instead of asking the symptoms again; a new run starts the file with the symptom and status open.
  action("lp.debug_session", async (c, rt) => {
    const slug = debugSessionSlug((c.input.with as Row | undefined)?.session ?? c.resolve("$inputs.session"));
    if (!slug) return { found: false, path: "" };
    const path = `.agents/planning/debug/${slug}.md`;
    const checkout = await pmCheckout(rt);
    const root = (await planHome(rt.projectId, checkout)) ?? checkout.path;
    const read = await runOnHost(ctx.host, { hostId: checkout.hostId, cwd: root, command: `test -f ${quote(path)} && cat ${quote(path)} || true`, timeoutSec: 20, timeoutMs: 30_000 });
    if (read.exitCode === 0 && read.stdout.trim()) return { found: true, path };
    const content = debugSessionDoc(slug, c.resolve("$inputs.symptom"));
    try {
      if (root === checkout.path) noteEngineWrite(checkout.path, path);
      await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: root, path: `${root}/${path}`, content, contentEncoding: "utf8", createParents: true });
      return { found: false, path };
    } catch {
      return { found: false, path: "" };
    }
  });
}
