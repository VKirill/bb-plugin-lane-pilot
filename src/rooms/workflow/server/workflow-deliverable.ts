import { isPlanningPath } from "../../contracts";
import { pmCheckout, rec, str } from "./workflow-chain-runtime";
import type { Row, Services } from "./workflow-chain-runtime";
import { START } from "@lane-pilot/workflow-engine";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { runOnHost } from "@lane-pilot/host-calls";
import { pageReviewByAgent } from "../../critique/server";
import type { ChainRuntime } from "../../contracts/server";

type Action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;
type PlanHome = (projectId: string, checkout: { hostId: string; path: string }) => Promise<string | null>;

/** The `deliverable.validate` action form: the goal check of a deliverable graph on the artifact the run produced. */
export function registerDeliverableAction(action: Action, deps: { planHome: PlanHome; services: Services }): void {
  const { planHome, services } = deps;
  // chains-end: the goal check of a deliverable graph — validateDeliverable (validators room) on the artifact the
  // run produced, not "file exists": DOM → Jev → vision review for pages, kind validators for the rest.
  // The target is what the node declares (params, `{{ref}}` written in) or the edge maps in (`with`); run inputs
  // answer only when nothing is declared. A checkout-relative path is read on the PM checkout — or the planning
  // home for a planning file, the same root fs.write chose; an explicit foreign host takes absolute paths only.
  action("deliverable.validate", async (c, rt) => {
    const params = rec(rec(c.node).params);
    const inputs = (c.input.with ?? {}) as Row;
    const rework = (reason: string): Row => ({ ok: false, verdict: "rework", reason, details: {} });
    // The edge that delivered this step declares its mappings even where mapWith dropped an unresolved optional value;
    // a null fromStep is the entry edge. With several candidate edges any declared target mapping counts (fail closed).
    const fromStep = c.input.via?.fromStep;
    const fromNode = fromStep === null ? START : typeof fromStep === "string" ? fromStep.split("#")[0] ?? null : null;
    const edgeWith = Object.assign({}, ...c.workflow.edges.filter((candidate) => candidate.from === fromNode && candidate.to === c.node.id).map((candidate) => candidate.with ?? {})) as Row;
    const MISSING = Symbol("missing-target");
    const TARGET_KEYS = ["target", "deliverable", "path"];
    // params win over the edge's `with` as a source; inside a source the first declared alias wins; a declared value
    // that resolves to nothing is a refusal, never a fallthrough to another source or to run inputs.
    const declaredTarget = (source: Row, mapped: Row, write: boolean): unknown => {
      for (const key of TARGET_KEYS) {
        if (source[key] === undefined && mapped[key] === undefined) continue;
        const value = write ? c.template(source[key]) : source[key];
        return value === undefined || value === null ? MISSING : value;
      }
      return undefined;
    };
    const paramTarget = declaredTarget(params, {}, true);
    const withTarget = paramTarget === undefined ? declaredTarget(inputs, edgeWith, false) : undefined;
    const rawTarget = paramTarget ?? withTarget ?? c.resolve("$inputs.deliverable") ?? c.resolve("$inputs.path");
    if (rawTarget === MISSING || typeof rawTarget !== "string" || !rawTarget.trim()) return rework("deliverable.validate: no artifact target declared or resolved");
    const target = rawTarget.trim();
    const pickField = (keys: string[]): unknown => {
      for (const key of keys) if (params[key] !== undefined) return c.template(params[key]);
      for (const key of keys) if (inputs[key] !== undefined) return inputs[key];
      return undefined;
    };
    const rawValidator = pickField(["validator"]) ?? c.resolve("$inputs.validator");
    if (rawValidator !== undefined && typeof rawValidator !== "string") return rework("deliverable.validate: validator must name a kind");
    const validator = str(rawValidator).trim() || "artifact";
    const rawHost = pickField(["host", "hostId"]) ?? c.resolve("$inputs.hostId") ?? c.resolve("$inputs.host");
    if (rawHost !== undefined && typeof rawHost !== "string") return rework("deliverable.validate: host must be a host id");
    const declaredHost = str(rawHost).trim();
    const brief = rec(pickField(["brief"]) ?? c.resolve("$inputs.brief"));
    const { validateDeliverable } = await import("../../validators");
    const host = { run: (id: string, cwd: string, command: string, timeoutSec: number) => runOnHost(rt.ctx.host, { hostId: id, cwd, command, timeoutSec }) as never };
    const review = rt.projectId ? async (req: { url: string; brief: string; shots: string[]; dom: unknown }) => pageReviewByAgent(rt.ctx, services, {
      pmThreadId: rt.pmThreadId ?? "", projectId: rt.projectId!, parentRunId: rt.runId ?? c.runId ?? "",
      design: validator === "design" || Boolean(brief.design), request: req,
    }) : undefined;
    const isUrl = /^https?:\/\//i.test(target);
    // The checkout is needed to name the host of an undeclared location or to root a relative path; an absolute path
    // on an explicitly declared host stands alone.
    const checkout = !declaredHost || (!isUrl && !target.startsWith("/")) ? await pmCheckout(rt) : null;
    let path = target, hostId = declaredHost;
    if (!isUrl) {
      if (target.includes("\0")) return rework(`deliverable.validate: unsafe target "${target}"`);
      if (target.startsWith("/")) hostId = hostId || checkout!.hostId;
      else {
        if (declaredHost && declaredHost !== checkout!.hostId)
          return rework(`deliverable.validate: "${target}" is checkout-relative but host "${declaredHost}" is not the checkout host`);
        if (target.split("/").includes("..")) return rework(`deliverable.validate: unsafe target "${target}"`);
        const home = isPlanningPath(target) ? await planHome(rt.projectId, checkout!) : null;
        path = `${(home ?? checkout!.path).replace(/\/+$/, "")}/${target}`;
        hostId = checkout!.hostId;
      }
    } else if (!hostId) hostId = checkout!.hostId;
    const verdict = await validateDeliverable(validator, path, {
      host, ...(hostId ? { hostId } : {}), ...(Object.keys(brief).length ? { brief } : {}), ...(review ? { review } : {}),
    });
    return { ok: verdict.ok, verdict: verdict.ok ? "pass" : "rework", reason: verdict.reason, details: verdict.details ?? {} };
  });
}
