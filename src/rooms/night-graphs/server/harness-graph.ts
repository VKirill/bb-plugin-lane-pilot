import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { runGraphHelper, sumUsage } from "../../workflow/server";
import type { ChainRuntime } from "../../workflow/server";
import type { ServerCore, Services } from "../../core/server";
import type { HarnessStep } from "../../harness/server";

/**
 * The harness editor as graphs. `lp.harness-edit` (workflows/lp.harness-edit.json) is one improvement round for a key (project, area, writer):
 * `prepare` (code: the switch, an open trial, the folder), `edit` (the model work: evidence on disk, the invariant and the domain editor side by
 * side, the composer, each a helper thread of the step with its one retry on a rejected tree or an early end), `validate` (code: the composed tree
 * goes on trial as a candidate, or the round is recorded as «kept the base»). `lp.harness-reflect` is what runs after a trial decided: `prepare`,
 * `reflect` (one session reading both arms), `record` (the lesson enters the library and the rules pipeline). The nightly tick (`harness-nightly`)
 * stays code: it judges the trials and picks the keys, then starts a round for each; a dry run starts nothing. Both run with no PM chat.
 */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function mountHarnessGraph(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;
  const harness = services.harness;
  const input = (c: StepContext<ChainRuntime>, name: string): string => text(c.resolve(`$inputs.${name}`));
  const key = (c: StepContext<ChainRuntime>) => ({ projectId: input(c, "project_id"), area: input(c, "area"), writerKey: input(c, "writer_key") });
  const stepOf = (c: StepContext<ChainRuntime>): HarnessStep => ({ c, helper: (helper) => runGraphHelper(ctx, c, helper), runs: [] });

  engine.register<ChainRuntime>("lp.harness_prepare", {
    reentrant: true,
    run: async (c) => {
      const ready = await harness.graph.prepareEdit(key(c));
      return { output: { status: ready.status, detail: ready.detail, host_id: ready.hostId, path: ready.path, handoff: ready.status === "ready" ? "the round may start" : ready.detail } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.harness-editor", {
    // Every session is a spawn effect keyed by its stage and try: a step a reload cut off finds the threads it made and goes on from their results.
    reentrant: true,
    run: async (c) => {
      if (text(c.resolve("prepare.status")) !== "ready") {
        return { output: { status: "skipped", detail: text(c.resolve("prepare.detail")), tree: {}, inv_notes: "", dom_notes: "", compose_notes: "", thread_ids: [], handoff: "skipped" } };
      }
      const step = stepOf(c);
      const output = await harness.graph.editRound(step, { ...key(c), where: { hostId: text(c.resolve("prepare.host_id")), path: text(c.resolve("prepare.path")) }, stamp: c.runId.slice(-10) });
      return { output: { ...output, handoff: `${String(output.status)}${output.detail ? `: ${String(output.detail)}` : ""}` }, ...sumUsage(step.runs) };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.harness_validate", {
    reentrant: true,
    run: async (c) => {
      const edit = Object.fromEntries(["status", "detail", "tree", "inv_notes", "dom_notes", "compose_notes", "thread_ids"].map((field) => [field, c.resolve(`edit.${field}`)]));
      const validated = await harness.graph.validateEdit({ ...key(c), reason: input(c, "reason") || null }, edit);
      return { output: { status: validated.status, detail: validated.detail, candidate_id: validated.candidateId, handoff: `${validated.status}${validated.detail ? `: ${validated.detail}` : ""}` } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.harness_reflect_prepare", {
    reentrant: true,
    run: async (c) => {
      const ready = await harness.graph.prepareReflect(input(c, "trial_id"));
      return { output: { status: ready.status, detail: ready.detail, project_id: ready.projectId, host_id: ready.hostId, path: ready.path, folder: ready.folder, mission: ready.mission, handoff: ready.status === "ready" ? "the evidence is on disk" : ready.detail } };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.harness-reflection", {
    reentrant: true,
    run: async (c) => {
      if (text(c.resolve("prepare.status")) !== "ready") return { output: { text: "", handoff: "skipped" } };
      const step = stepOf(c);
      const answer = await harness.graph.reflectSession(step, input(c, "trial_id"), {
        projectId: text(c.resolve("prepare.project_id")), hostId: text(c.resolve("prepare.host_id")), path: text(c.resolve("prepare.path")), folder: text(c.resolve("prepare.folder")), mission: text(c.resolve("prepare.mission")),
      });
      return { output: { text: answer, handoff: "reflected" }, ...sumUsage(step.runs) };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.harness_reflect_record", {
    reentrant: true,
    run: async (c) => {
      if (text(c.resolve("prepare.status")) !== "ready") return { output: { status: "skipped", detail: text(c.resolve("prepare.detail")), handoff: "skipped" } };
      const recorded = harness.graph.recordReflect(input(c, "trial_id"), text(c.resolve("reflect.text")));
      return { output: { status: recorded.status, detail: recorded.detail, handoff: recorded.detail } };
    },
  } as NodeExecutor<ChainRuntime>);
}
