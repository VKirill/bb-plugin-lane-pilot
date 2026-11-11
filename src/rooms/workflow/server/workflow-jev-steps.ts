import { rec, list, str } from "./workflow-chain-runtime";
import type { Row } from "./workflow-chain-runtime";
import { bestEffort } from "@lane-pilot/kit";
import type { GraphNode, NodeExecutor, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { getJudgment, jev } from "@lane-pilot/jev";
import { citationCheckJudgment } from "@lane-pilot/jev/judgments/citation-check";
import type { Judgment } from "@lane-pilot/jev";
import { pickSkillTree, readSkillTreeText, skillTreeCached } from "../../platform/server";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";

/** The Jev steps of a chain: the native `jev` node, the citation check, and the skill-tree pick — one cheap judgment call, no helper thread. */
export function registerJevSteps(engine: WorkflowEngine, ctx: ServerCore, deps: {
  runtimeOf: (c: { runtime: unknown }, runId?: string) => ChainRuntime | undefined;
}): void {
  const { runtimeOf } = deps;

  // The native System One node (`type:"jev"`): a registered judgment answers the node's `state` whitelist in one cheap
  // call — no helper thread. An unsure verdict comes back `escalated`; the graph routes it to a model step with a `when`
  // edge (`out.escalated == true`). Jev off or unavailable escalates to `model` so the graph's model edge takes it.
  engine.register<ChainRuntime>("builtin:jev", {
    reentrant: true,
    run: async (c) => {
      const node = c.node as Extract<GraphNode, { type: "jev" }>;
      const judgment = getJudgment(node.judgment) as Judgment<Record<string, unknown>, unknown> | undefined;
      if (!judgment) throw new Error(`builtin:jev: unknown judgment "${node.judgment}" (the id is registered in the Jev layer, e.g. route.workflow)`);
      const rt = c.runtime;
      const settings = rt ? (((await bestEffort(rt.ctx.log, "workflow jev settings", rt.ctx.effectiveProjectSettings(rt.projectId), null))?.values) ?? {}) : {};
      // The whitelist, field by field; a long text is clipped with a marker (no spread of run data into the state).
      // `"$task.<path>"` reads the dispatch task's own fields (title, contract) — the spec stays the whitelist.
      const state: Record<string, unknown> = {};
      const task = (rt as { task?: Record<string, unknown> } | undefined)?.task;
      for (const [name, spec] of Object.entries(node.state)) {
        let value: unknown;
        if (typeof spec === "string" && spec.startsWith("$task.")) {
          let at: unknown = task;
          for (const part of spec.slice(6).split(".")) at = (at as Record<string, unknown> | null)?.[part];
          value = at === undefined || at === null ? "" : typeof at === "object" ? JSON.stringify(at) : at;
        } else value = c.template(spec);
        state[name] = typeof value === "string" && value.length > 4_000 ? `${value.slice(0, 3_999)}…` : value;
      }
      const instance = jev();
      // `value` is always the judgment's fallback when Jev did not answer, so a graph reading `value.*` never fails closed.
      if (!instance || !instance.enabled(settings)) { const fb = judgment.fallback(state); return { output: { decision: "jev_unavailable", value: fb, ...(fb && typeof fb === "object" ? fb as Record<string, unknown> : {}), escalated: true, to: "model" } }; }
      // The decision's own fields also sit at the top level of the output, so an artifact consumer or a `when` edge can
      // read them directly (goal-screen.goals) while `value` keeps the whole object for a nested read.
      const flat = (decision: unknown) => (decision && typeof decision === "object" && !Array.isArray(decision) ? decision as Record<string, unknown> : {});
      // In a task's own pipeline the receipt names the task: the nightly labels find a task's fate by run and subject.
      const verdict = await instance.judge(judgment, state, { projectId: rt?.projectId ?? null, runId: rt?.runId ?? null, subject: typeof task?.["id"] === "string" && task["id"] ? task["id"] : node.id, settings });
      const handoff = (decision: unknown) => (decision && typeof decision === "object" ? judgment.describe(decision) : "escalated");
      // `receiptId` and `would` let a later step label the receipt with what really happened (`jev().outcome`): `would` is the
      // decision Jev gave or, in shadow, would have given — the fallback that actually applied is in `decision`. A graph that
      // does not declare them in the node's output does not see them.
      const receipt = verdict.receiptId === null ? {} : { receiptId: verdict.receiptId };
      if (verdict.by === "jev") return { output: { decision: judgment.describe(verdict.decision), handoff: handoff(verdict.decision), value: verdict.decision, ...flat(verdict.decision), escalated: false, ...receipt, would: judgment.describe(verdict.decision) } };
      if (verdict.by === "escalate") return { output: { decision: `escalate:${verdict.to}`, handoff: `escalated to ${verdict.to}`, escalated: true, to: verdict.to, ...receipt } };
      const would = verdict.shadow?.decision ?? verdict.decision;
      return { output: { decision: judgment.describe(verdict.decision), handoff: handoff(verdict.decision), value: verdict.decision, ...flat(verdict.decision), escalated: false, fallback: true, status: verdict.status, ...receipt, would: judgment.describe(would) } };
    },
  } as NodeExecutor<ChainRuntime>);
  // `citations.jev`: for each {claim, source, excerpt} triple Jev decides whether the source supports the claim
  // (research.citation, shadow by default — verdicts go to receipts and to `citation_check` in the output).
  engine.register<ChainRuntime>("citations.jev", { reentrant: true, run: async (c) => {
    const params = rec(rec(c.node).params);
    const items = list((c.input.with as Row | undefined)?.[str(params.items ?? "citations")] ?? c.inputs[str(params.items ?? "citations")]);
    const rt = runtimeOf(c, c.runId);
    const judge = jev();
    if (!judge || !items.length) return { output: { checked: 0, kept: items.length, verdicts: [] } };
    const inputs = items.map((item) => {
      const row = rec(item);
      return { claim: str(row.claim), quote: str(row.quote), sourceTitle: str(row.title ?? row.source_title), sourceUrl: str(row.url ?? row.source_url), excerpt: str(row.excerpt ?? row.text), question: str(row.question) };
    });
    const settings = rt?.projectId ? await bestEffort(ctx.log, "workflow settings", ctx.effectiveProjectSettings(rt.projectId).then((r) => r.values as Record<string, unknown>), {}) : {};
    const verdicts = await judge.judgeMany(citationCheckJudgment, inputs, { projectId: rt?.projectId ?? null, runId: rt?.runId ?? null, settings });
    const out = verdicts.map((v, i) => {
      const decision = v.by === "jev" ? v.decision : v.by === "fallback" && v.shadow?.decision ? v.shadow.decision : citationCheckJudgment.fallback(inputs[i]!);
      return { index: i, verdict: decision.verdict, keep: decision.keep, by: v.by === "jev" ? "jev" : "fallback" };
    });
    return { output: { checked: verdicts.length, kept: out.filter((v) => v.keep).length, verdicts: out } };
  } });

  // `skills.jev`: Jev walks the catalog tree for this step (skills.tree_pick, hierarchical) and returns the picked
  // skill names — a graph passes {task} instead of listing skills in the prompt.
  engine.register<ChainRuntime>("skills.jev", { reentrant: true, run: async (c) => {
    const params = rec(rec(c.node).params);
    const task = str(params.task ?? (c.input.with as Row | undefined)?.task ?? c.inputs.task);
    const rt = runtimeOf(c, c.runId);
    const judge = jev();
    if (!judge) return { output: { skills: [], picked: [], by: "off" } };
    
    const tree = await skillTreeCached(readSkillTreeText);
    if (!tree) return { output: { skills: [], picked: [], by: "off" } };
    const settings = rt?.projectId ? await bestEffort(ctx.log, "workflow settings", ctx.effectiveProjectSettings(rt.projectId).then((r) => r.values as Record<string, unknown>), {}) : {};
    const got = await pickSkillTree(judge, tree, { title: task, prompt: "" }, { projectId: rt?.projectId ?? null, runId: rt?.runId ?? null, settings });
    return { output: { skills: got.skills, picked: got.picked, by: got.by } };
  } });
}
