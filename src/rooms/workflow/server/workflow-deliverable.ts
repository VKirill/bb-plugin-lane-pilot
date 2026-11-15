import { isPlanningPath } from "../../contracts";
import { listRunFiles, runHomeOf } from "../../storage";
import { pmCheckout, rec, str } from "./workflow-chain-runtime";
import type { Row, Services } from "./workflow-chain-runtime";
import { nodeRefStep, refOf, START, wfChildRuns } from "@lane-pilot/workflow-engine";
import type { StepContext, StepRow, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { isNotFound, orMiss, stringAt } from "@lane-pilot/kit";
import { runOnHost } from "@lane-pilot/host-calls";
import { pageReviewByAgent } from "../../critique/server";
import type { ChainRuntime } from "../../contracts/server";

type Action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;
type PlanHome = (projectId: string, checkout: { hostId: string; path: string }) => Promise<string | null>;

/** The `deliverable.validate` action form: the goal check of a deliverable graph on the artifact the run produced. */
export function registerDeliverableAction(action: Action, deps: { planHome: PlanHome; services: Services; engine: WorkflowEngine }): void {
  const { planHome, services, engine } = deps;
  // chains-end: the goal check of a deliverable graph — validateDeliverable (validators room) on the artifact the
  // run produced, not "file exists": DOM → Jev → vision review for pages, kind validators for the rest.
  // The target is what the node declares (params, `{{ref}}` written in) or the edge maps in (`with`); run inputs
  // answer only when nothing is declared. A relative path is read on the proven producer's root — the PM checkout or
  // planning home for fs.write, the bound thread environment for a single agent — and an explicit foreign host takes
  // absolute paths only.
  action("deliverable.validate", async (c, rt) => {
    const params = rec(rec(c.node).params);
    const inputs = (c.input.with ?? {}) as Row;
    const rework = (reason: string): Row => ({ ok: false, verdict: "rework", reason, details: {} });
    const journal = engine.journal;
    const self = journal.getStep(c.runId, c.stepKey);
    // The persisted delivery names the exact edge: edge_index into workflow.edges, parent_key the delivering step
    // (null means the entry edge from START). An inconsistent record leaves edge-mapped targets unverifiable.
    const edge = typeof self?.edge_index === "number" ? c.workflow.edges[self.edge_index] : undefined;
    const edgeFrom = self?.parent_key ? journal.getStep(c.runId, self.parent_key)?.node_id : START;
    const edgeWith = edge && edge.to === c.node.id && edge.from === edgeFrom ? ((edge.with ?? {}) as Row) : null;
    const MISSING = Symbol("missing-target");
    const TARGET_KEYS = ["target", "deliverable", "path"];
    // params win over the edge's `with` as a source; inside a source the first declared alias wins; a declared value
    // that resolves to nothing is a refusal, never a fallthrough to another source or to run inputs.
    type Hit = { key: string; value: unknown } | typeof MISSING | undefined;
    const declaredTarget = (source: Row, mapped: Row, write: boolean): Hit => {
      for (const key of TARGET_KEYS) {
        if (source[key] === undefined && mapped[key] === undefined) continue;
        const value = write ? c.template(source[key]) : source[key];
        return value === undefined || value === null ? MISSING : { key, value };
      }
      return undefined;
    };
    const paramHit = declaredTarget(params, {}, true);
    const withHit = paramHit === undefined ? (edgeWith === null ? MISSING : declaredTarget(inputs, edgeWith, false)) : undefined;
    const selected = paramHit ?? withHit;
    const rawTarget = selected === undefined ? (c.resolve("$inputs.deliverable") ?? c.resolve("$inputs.path")) : selected === MISSING ? MISSING : selected.value;
    if (rawTarget === MISSING || typeof rawTarget !== "string" || !rawTarget.trim()) return rework("deliverable.validate: no artifact target declared or resolved");
    const target = rawTarget.trim();
    const pickField = (keys: string[]): unknown => {
      for (const key of keys) if (params[key] !== undefined) return c.template(params[key]);
      for (const key of keys) if (inputs[key] !== undefined) return inputs[key];
      return undefined;
    };
    const rawHost = pickField(["host", "hostId"]) ?? c.resolve("$inputs.hostId") ?? c.resolve("$inputs.host");
    if (rawHost !== undefined && typeof rawHost !== "string") return rework("deliverable.validate: host must be a host id");
    const declaredHost = str(rawHost).trim();
    const isUrl = /^https?:\/\//i.test(target);
    const tilde = target === "~" || target.startsWith("~/");
    // An explicit host with an absolute path, URL or `~` is a complete location: no producer lookup at all.
    const standalone = Boolean(declaredHost) && (isUrl || tilde || target.startsWith("/"));
    // Otherwise a node reference names its producer: resolve that exact step (rowid-ceilined for an edge mapping,
    // latest-in-scope for an execution-time `{{ref}}` template), require it on the delivering step's parent_key
    // ancestry, then take the location its own contract proves — a single agent's bound thread environment, or the
    // PM/planning convention of a positively identified fs.write. Anything else is named unverified, never inferred.
    let producerRoot: { hostId: string; path: string } | null = null;
    let agentProducer = false;
    // A run-file-registry root is historical fact: it never re-resolves through the current planning-home setting.
    let recordedRoot = false;
    if (!standalone) {
      const unverified = (why: string): Row => rework(`deliverable.validate: producer provenance unverified (${why})`);
      const run = journal.getRun(c.runId);
      const fromRow = self?.parent_key ? journal.getStep(c.runId, self.parent_key) : null;
      const ancestorOf = (step: StepRow): boolean => {
        const seen = new Set<string>();
        for (let cur: StepRow | null | undefined = fromRow; cur && !seen.has(cur.step_key); cur = cur.parent_key ? journal.getStep(c.runId, cur.parent_key) : null) {
          seen.add(cur.step_key);
          if (cur.step_key === step.step_key) return true;
        }
        return false;
      };
      const bindLocation = async (nodeId: string, producerStep: StepRow): Promise<Row | null> => {
        const node = c.workflow.nodes.find((candidate) => candidate.id === nodeId);
        if (node?.type === "agent") {
          if (Number(rec(node).votes ?? 1) > 1) return unverified("multi-vote step keeps no per-field provenance");
          const receipt = rec(JSON.parse(producerStep.receipt_json ?? "{}") as unknown);
          const threadId = str(receipt.threadId);
          const thread = threadId ? await orMiss(rt.ctx.bb.sdk.threads.get({ threadId }), null, isNotFound) : null;
          const environmentId = stringAt(thread, "environmentId");
          const env = environmentId ? await orMiss(rt.ctx.bb.sdk.environments.get({ environmentId }), null, isNotFound) : null;
          const envHost = stringAt(env, "hostId"), envPath = stringAt(env, "path");
          if (!envHost || !envPath) return unverified("producer thread environment unreadable");
          producerRoot = { hostId: envHost, path: envPath };
          agentProducer = true;
          return null;
        }
        if (node?.type === "action" && rec(node).action === "fs.write") {
          producerRoot = await pmCheckout(rt);
          return null;
        }
        if (node?.type === "subworkflow") {
          // The step's output is its child run's emit; the referenced file was written inside the child, so
          // provenance is the child's own run-file row and run home, bound by (parent_run_id, parent_step_key).
          const children = wfChildRuns(engine.journal.db, c.runId).filter((child) => child.parent_step_key === producerStep.step_key);
          const child = children.length === 1 ? engine.journal.getRun(children[0]!.id) : undefined;
          if (!child || child.status !== "succeeded") return unverified("subworkflow child run missing or not succeeded");
          const repoPath = target.replace(/^\.\/+/, "");
          const file = listRunFiles(engine.journal.db, child.id).find((candidate) => candidate.repo_path === repoPath && candidate.kind === "output");
          if (!file) return unverified(`child run recorded no output file at "${repoPath}"`);
          if (file.root !== "checkout") return unverified(`recorded root "${file.root}" has no immutable historical root`);
          const defNodes = rec(JSON.parse(child.definition_json) as unknown).nodes;
          const writer = (Array.isArray(defNodes) ? defNodes : []).map((entry) => rec(entry)).find((entry) => entry.id === file.node_id);
          if (rec(writer).type !== "action" || rec(writer).action !== "fs.write")
            return unverified(`child producer "${file.node_id}" is not fs.write`);
          const producer = rec(JSON.parse(file.producer_json) as unknown);
          if (str(producer.run_id) !== child.id || str(producer.node) !== file.node_id) return unverified("run-file row is not bound to this child run and node");
          const wfStep = str(producer.wf_step_key);
          const boundStep = wfStep ? engine.journal.getStep(child.id, wfStep) : undefined;
          if (!boundStep || boundStep.node_id !== file.node_id || boundStep.state !== "succeeded") return unverified("run-file producer step unreadable");
          const home = runHomeOf(engine.journal.db, child.id);
          if (!home) return unverified("child run home not recorded");
          producerRoot = { hostId: home.host_id, path: home.base_path };
          recordedRoot = true;
          return null;
        }
        return unverified(`producer "${nodeId}" (${node?.type ?? "unknown"}) has no location contract`);
      };
      if (withHit !== undefined && withHit !== MISSING && selected === withHit) {
        // node.with is spread over the edge's mapping at step start (a same-value override is still an override),
        // and a rerun keeps edge_index/parent_key/rowid while patching input.with — neither is edge provenance.
        const nodeWith = rec(rec(c.node).with);
        const overridden = withHit.key in nodeWith;
        if (overridden || Number(c.input.rerun ?? 0) > 0)
          return unverified(overridden ? "node.with overrides the edge-mapped target" : "a rerun delivered patched inputs");
        const refText = edgeWith?.[withHit.key];
        const ref = typeof refText === "string" ? refOf(refText) : null;
        if (ref?.kind === "node" && ref.node) {
          if (!self || !run || (self.parent_key !== null && !fromRow)) return unverified("delivering step unreadable");
          const found = nodeRefStep(engine, run, fromRow ?? null, c.stepKey, ref);
          if (!found || found.value !== withHit.value) return unverified("mapped value's producer step not found");
          if (!ancestorOf(found.step)) return unverified("producer is not on the delivering step's ancestry");
          const bound = await bindLocation(ref.node, found.step);
          if (bound) return bound;
        } else if (ref === null) {
          return unverified("with-source target is not edge-mapped");
        }
      } else if (paramHit !== undefined && paramHit !== MISSING) {
        const raw = params[paramHit.key];
        const lone = typeof raw === "string" ? /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(raw) : null;
        if (lone) {
          const ref = refOf(lone[1] ?? "");
          if (ref.kind === "node" && ref.node) {
            if (!self || !run || (self.parent_key !== null && !fromRow)) return unverified("delivering step unreadable");
            const found = nodeRefStep(engine, run, self, c.stepKey, ref, false);
            if (!found || found.value !== rawTarget) return unverified("template's producer step not found");
            if (!ancestorOf(found.step)) return unverified("producer is not on the delivering step's ancestry");
            const bound = await bindLocation(ref.node, found.step);
            if (bound) return bound;
          }
        } else if (typeof raw === "string" && raw.includes("{{")) {
          return unverified("embedded params template names no provable producer");
        }
      }
    }
    const rawValidator = pickField(["validator"]) ?? c.resolve("$inputs.validator");
    if (rawValidator !== undefined && typeof rawValidator !== "string") return rework("deliverable.validate: validator must name a kind");
    const validator = str(rawValidator).trim() || "artifact";
    const brief = rec(pickField(["brief"]) ?? c.resolve("$inputs.brief"));
    const { validateDeliverable } = await import("../../validators");
    const host = { run: (id: string, cwd: string, command: string, timeoutSec: number) => runOnHost(rt.ctx.host, { hostId: id, cwd, command, timeoutSec }) as never };
    const review = rt.projectId ? async (req: { url: string; brief: string; shots: string[]; dom: unknown }) => pageReviewByAgent(rt.ctx, services, {
      pmThreadId: rt.pmThreadId ?? "", projectId: rt.projectId!, parentRunId: rt.runId ?? c.runId ?? "",
      design: validator === "design" || Boolean(brief.design), request: req,
    }) : undefined;
    // The proven producer root stands in for the checkout; a standalone location needs neither.
    const root = producerRoot ?? (!standalone ? await pmCheckout(rt) : null);
    let path = target, hostId = declaredHost;
    if (!isUrl) {
      if (target.includes("\0")) return rework(`deliverable.validate: unsafe target "${target}"`);
      if (tilde) {
        const homeHost = declaredHost || root!.hostId;
        const dir = await Promise.resolve().then(() => rt.ctx.bb.sdk.hosts.directory({ hostId: homeHost })).catch(() => null);
        const home = (stringAt(dir, "directory") ?? "").trim();
        if (!home) return rework(`deliverable.validate: cannot resolve "~" on host "${homeHost}"`);
        const rest = target === "~" ? "" : target.slice(2);
        if (rest.split("/").includes("..")) return rework(`deliverable.validate: unsafe target "${target}"`);
        path = rest ? `${home.replace(/[\\/]+$/, "")}/${rest}` : home;
        hostId = homeHost;
      } else if (target.startsWith("/")) hostId = hostId || root!.hostId;
      else {
        if (declaredHost && declaredHost !== root!.hostId)
          return rework(`deliverable.validate: "${target}" is checkout-relative but host "${declaredHost}" is not the checkout host`);
        if (target.split("/").includes("..")) return rework(`deliverable.validate: unsafe target "${target}"`);
        const home = !agentProducer && !recordedRoot && isPlanningPath(target) ? await planHome(rt.projectId, root!) : null;
        path = `${(home ?? root!.path).replace(/\/+$/, "")}/${target}`;
        hostId = root!.hostId;
      }
    } else if (!hostId) hostId = root!.hostId;
    const verdict = await validateDeliverable(validator, path, {
      host, ...(hostId ? { hostId } : {}), ...(Object.keys(brief).length ? { brief } : {}), ...(review ? { review } : {}),
    });
    return { ok: verdict.ok, verdict: verdict.ok ? "pass" : "rework", reason: verdict.reason, details: verdict.details ?? {} };
  });
}
