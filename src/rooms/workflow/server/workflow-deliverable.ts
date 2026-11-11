import { rec, str } from "./workflow-chain-runtime";
import type { Row } from "./workflow-chain-runtime";
import { bestEffort } from "@lane-pilot/kit";
import type { NodeExecutor, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { runOnHost } from "@lane-pilot/host-calls";
import { pageReviewByAgent } from "../../critique/server";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";
import type { Services } from "./workflow-chain-runtime";

type Action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;

/** The `deliverable.validate` executor: the three-layer acceptance of a non-code artifact (see docs/workflow-executors.md). */
export function registerDeliverableNode(engine: WorkflowEngine, ctx: ServerCore, services: Services, deps: {
  runtimeOf: (c: { runtime: unknown }, runId?: string) => ChainRuntime | undefined;
}): void {
  const { runtimeOf } = deps;

  // `deliverable.validate` — the three-layer acceptance of a non-code artifact (see docs/workflow-executors.md):
  // in:  { validator: "page"|"design"|"text"|"3d"|"video"|"invoice"|"composite"|"artifact", target, brief?, hostId? }
  // out: { verdict: "pass"|"rework"|"fail", reason, issues? } — the step's own rules turn rework into a revision.
  engine.register<ChainRuntime>("deliverable.validate", { reentrant: true, run: async (c) => {
    const params = rec(rec(c.node).params);
    const w = (c.input.with ?? {}) as Row;
    const pick = (key: string) => params[key] ?? w[key] ?? c.inputs[key];
    const validator = str(pick("validator") ?? "artifact"), target = str(pick("target") ?? pick("deliverable") ?? pick("path"));
    const rt = runtimeOf(c, c.runId);
    if (!target) throw new Error("deliverable.validate: no target");
    const hostId = str(pick("hostId") ?? "");
    const settings = rt?.projectId ? await bestEffort(ctx.log, "workflow settings", ctx.effectiveProjectSettings(rt.projectId).then((r) => r.values as Record<string, unknown>), {}) : {};
    const { validateDeliverable } = await import("../../validators");
    const verdict = await validateDeliverable(validator, target, {
      host: { run: (id, cwd, command, timeoutSec) => runOnHost(ctx.host, { hostId: id, cwd, command, timeoutSec }) as never },
      hostId,
      brief: rec(pick("brief")),
      jevCtx: { projectId: rt?.projectId ?? null, runId: rt?.runId ?? c.runId ?? null, settings },
      review: rt?.projectId ? async (req) => pageReviewByAgent(ctx, services, {
        pmThreadId: rt.pmThreadId ?? "", projectId: rt.projectId!, parentRunId: rt.runId ?? c.runId ?? "",
        design: validator === "design" || Boolean(rec(pick("brief")).design), request: req,
      }) : undefined,
    });
    const out = verdict.ok ? "pass" : "rework";
    return { output: { verdict: out, reason: verdict.reason, ...(verdict.details ? { issues: verdict.details } : {}) } };
  } });
}

/** The `deliverable.validate` action form: the goal check of a deliverable graph on the artifact the run produced. */
export function registerDeliverableAction(action: Action): void {
  // chains-end: the goal check of a deliverable graph — validateDeliverable (validators room) on the artifact the
  // run produced, not "file exists": DOM → Jev → vision review for pages, kind validators for the rest.
  // Node fields: validator (text|design|page|3d|video|invoice|composite|artifact), path (artifact path or url), brief.
  action("deliverable.validate", async (c, rt) => {
    const node = c.node as { validator?: string; path?: string; brief?: unknown; host?: string };
    const { validateDeliverable } = await import("../../validators");
    const inputs = (c.input.with ?? {}) as Record<string, unknown>;
    const path = String(node.path ?? inputs.path ?? c.resolve("$inputs.deliverable") ?? c.resolve("$inputs.path") ?? "");
    const validator = String(node.validator ?? inputs.validator ?? c.resolve("$inputs.validator") ?? "artifact");
    const hostId = String(node.host ?? inputs.hostId ?? c.resolve("$inputs.hostId") ?? "");
    const brief = (node.brief ?? inputs.brief ?? c.resolve("$inputs.brief")) as Record<string, unknown> | undefined;
    const settings = await bestEffort(rt.ctx.log, "workflow settings", rt.ctx.effectiveProjectSettings?.(rt.projectId).then((r) => r.values as Record<string, unknown>), {}) ?? {};
    const verdict = await validateDeliverable(validator, path, {
      host: { run: (id, cwd, command, timeoutSec) => runOnHost(rt.ctx.host, { hostId: id, cwd, command, timeoutSec }) as never },
      ...(hostId ? { hostId } : {}), ...(brief ? { brief } : {}),
      jevCtx: { projectId: rt.projectId, runId: rt.runId ?? null, settings },
    });
    return { ok: verdict.ok, verdict: verdict.ok ? "pass" : "rework", reason: verdict.reason, details: verdict.details ?? {} };
  });
}
