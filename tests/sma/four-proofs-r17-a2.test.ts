// Region 17 · Agent roles (subagents), part 2 — fixing, debugging and verifying roles (n1372–n1378). See four-proofs-r17-a.test.ts.
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { buildAcceptanceCard } from "../../src/rooms/acceptance/card";
import { getBaseline } from "../../src/rooms/baseline";
import { roleProfilePolicy } from "../../src/rooms/contracts/helper-context";
import { blindVerdict } from "../../src/rooms/phase/logic";
import { ANIMATOR_FREQUENT_RULE, ANIMATOR_LAW, conclusionText, piecePlan } from "../../src/rooms/phase/stages";
import { writerBriefSegments } from "../../src/rooms/writer/server/writer-task";
import { agentRequest, roleSpec } from "../../src/rooms/workflow/server/workflow-agent";
import { world } from "../baseline/world";
import { chainStore, runSim } from "../workflow/chain-harness";
import { out, pathOf } from "../workflow/chain-helpers";

type AgentNode = Extract<GraphNode, { type: "agent" }>;
async function spawnOf(workflowId: string, nodeId: string) {
  const flow = (await chainStore()).get(workflowId)!.workflow;
  const node = flow.nodes.find((candidate) => candidate.id === nodeId) as AgentNode;
  const ctx = {
    runtime: { pmThreadId: "t", projectId: "", runId: "r", ctx: {}, services: {} }, workflow: flow, node, nodeId, runId: "wfrun", stepKey: `${nodeId}#1`, spawnKey: "k", mode: "standard",
    signal: new AbortController().signal, input: { with: {}, via: { mode: "artifact", fromStep: null } }, goals: [], reground: false, render: (text: string) => text, template: (value: unknown) => value,
  } as unknown as StepContext<never>;
  const request = agentRequest(ctx as never, node);
  return { node, request, spec: roleSpec(request.role), fields: Object.fromEntries(request.fields.map((field) => [field.name, field.type])) as Record<string, string> };
}

const finding = (severity: string, file: string) => ({ file, line: 12, severity, evidence: `${file}: return value of save() ignored`, dimension: "correctness" });
const FINDINGS = [finding("high", "src/a.ts"), finding("medium", "src/b.ts")];

describe("region 17 · fixing and debugging roles", () => {
  it("[sma:k_ag_executor] the writer is told Lane Pilot commits and merges, and the phase conclusion names every piece with its task, state and promise", () => {
    const task = { schema_version: 2, id: "p1", display_title: "p1", kind: "feature", title: "p1", risk: "low", lane: "writer", project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.txt"], owns_paths: ["a/**"], never_touch: [], acceptance: ["a.txt exists"], verification: [{ command: "test -f a.txt" }], depends_on: [], objective: "o" };
    const brief = writerBriefSegments(task as never).map((segment) => segment.text).join("\n");
    expect(brief).toContain("Lane Pilot commits and merges your accepted changes");
    const items = [
      { id: "a", title: "A", wave: 1, promise: { given: "g", when: "it is opened", then: "A works" }, task: {} },
      { id: "b", title: "B", wave: 1, promise: { given: "g", when: "it is closed", then: "B works" }, task: {} },
    ] as never[];
    const facts = new Map([["a", { taskId: "task_a", state: "accepted" }], ["b", { taskId: "task_b", state: "blocked" }]]) as never;
    const summary = conclusionText({ id: "ph_9", title: "T", goal: "g", record: { plan: { items } } } as never, [], facts);
    expect(summary).toContain("# Summary");
    expect(summary).toContain("- a (task task_a, accepted): A works");
    expect(summary).toContain("- b (task task_b, blocked): B works");
  });

  it("[sma:k_ag_animator] a motion piece carries the animator's law and the frequent-action rule into its plan, a plain piece and a phase without piece notes do not", () => {
    const piece = (title: string, when: string) => ({ id: title, title, wave: 1, promise: { given: "a screen", when, then: "it holds" }, task: { owns_paths: ["src/ui/x.css"] } }) as never;
    const phase = (pieceNotes: boolean) => ({ id: "ph_1", title: "t", record: { pieceNotes } }) as never;
    const motion = piecePlan(phase(true), piece("HUD motion", "the panel moves"));
    expect(motion).toContain(`Motion (the animator's law): ${ANIMATOR_LAW}`);
    expect(motion).toContain(ANIMATOR_FREQUENT_RULE);
    expect(piecePlan(phase(true), piece("Copy", "the label stays"))).not.toContain("animator's law");
    expect(piecePlan(phase(false), piece("HUD motion", "the panel moves"))).not.toContain("animator's law");
  });

  it("[sma:k_ag_codefixer] the findings of the review go to the planner as gaps, the planned tasks go to the build, and a re-review that is not clean fixes its own findings", async () => {
    const plan = { status: "ok", tasks: [{ id: "fix-a", objective: "fix a" }], waves: [["fix-a"]] };
    const second = { status: "ok", tasks: [{ id: "fix-b", objective: "fix b" }], waves: [["fix-b"]] };
    const left = [finding("high", "src/c.ts")];
    const r = await runSim("review-fix", {
      input: { goal: "fix the review", findings: FINDINGS },
      stubs: { plan_fix: plan, plan_fix2: second, build_fix: { merged_commits: ["c1"] }, build_fix2: { merged_commits: ["c2"] }, re_review: [{ status: "rework", findings: left, remaining_actionable: 1 }, { status: "pass", findings: [], remaining_actionable: 0 }] },
    });
    expect(r.called("first_review")).toEqual([]);
    expect(r.called("plan_fix")[0]!.input).toMatchObject({ mode: "gaps", gaps: FINDINGS });
    expect(r.called("build_fix")[0]!.input).toMatchObject({ tasks: plan.tasks, waves: plan.waves });
    expect(r.called("plan_fix2")[0]!.input).toMatchObject({ mode: "gaps", gaps: left });
    expect(r.called("build_fix2")[0]!.input).toMatchObject({ tasks: second.tasks, waves: second.waves });
    expect(pathOf(r)).toBe("first_review plan_fix build_fix re_review plan_fix2 build_fix2 re_review done");
    expect(out(r)).toMatchObject({ status: "done", review_status: "pass" });
  });

  it("[sma:k_ag_debugger] the debugger step spawns a read-only debugger that is handed the scientific method, and its evidence path is the answer", async () => {
    const investigate = await spawnOf("debug", "investigate");
    expect(investigate.spec).toMatchObject({ helper: "debugger", readOnly: true });
    expect(investigate.request.prompt).toContain("No fix without a confirmed root cause");
    expect(investigate.request.prompt).toContain("at most 3 hypotheses");
    expect(investigate.fields).toMatchObject({ status: "enum", root_cause: "string", evidence_path: "string", confidence: "number" });
    expect(roleProfilePolicy("debugger").skills).toEqual({ mode: "allow", names: ["gitnexus-debugging"] });
    // A planner (a role without the debugger's method) is not handed it.
    const planner = await spawnOf("ai-integration-phase", "eval_plan");
    expect(planner.request.prompt).not.toContain("at most 3 hypotheses");
    const r = await runSim("debug", { input: { symptom: "the save button does nothing when the list is empty, since Tuesday, error TypeError" }, stubs: { investigate: { status: "confirmed", root_cause: "list[0] read on empty", mechanism: "m", confidence: 80, evidence_path: ".agents/planning/debug/s.md", affected_files: ["src/save.ts"], fix_direction: "guard the empty list", pressure_pass: true, contradictions: 0, refuted: 1 } } });
    expect(out(r)).toMatchObject({ status: "confirmed", root_cause: "list[0] read on empty", evidence_path: ".agents/planning/debug/s.md" });
  });

  it("[sma:k_ag_debugmgr] a fresh session re-checks the cause, an objection sends the debugger back while it has visits left, and a cause that stands is answered compactly", async () => {
    const verify = await spawnOf("debug", "verify_cause");
    expect(verify.node.session).toBe("new");
    const stand = { status: "confirmed", root_cause: "list[0] on empty", mechanism: "m", confidence: 80, evidence_path: "e.md", affected_files: ["src/save.ts"], fix_direction: "guard", pressure_pass: true, contradictions: 0 };
    const input = { symptom: "x".repeat(60) };
    const ok = await runSim("debug", { input, mode: "full", stubs: { investigate: stand, verify_cause: [{ confirmed: false, objections: ["a cheaper cause at src/a.ts:3"] }, { confirmed: true, objections: [] }] } });
    expect(pathOf(ok)).toContain("investigate verify_cause investigate verify_cause confirmed");
    expect(out(ok)).toMatchObject({ status: "confirmed", root_cause: "list[0] on empty", confidence: 80, affected_files: ["src/save.ts"], fix_direction: "guard", evidence_path: "e.md" });
    // An objection that is never answered is not looped on forever: the third round ends as partial.
    const stuck = await runSim("debug", { input, mode: "full", stubs: { investigate: stand, verify_cause: { confirmed: false, objections: ["still a cheaper cause"] } } });
    expect(stuck.called("investigate")).toHaveLength(3);
    expect(out(stuck)).toMatchObject({ status: "partial" });
  });
});

describe("region 17 · the roles that check the whole", () => {
  const item = (id: string) => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id, kind: "feature", acceptance: ["a"], verification: [{ command: "npm test" }] } }) as never;
  const fact = (taskId: string, over: Record<string, unknown> = {}) => ({ taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", ...over }) as never;

  it("[sma:k_ag_verifier] a piece whose promise is not proved fails the phase, a piece that is proved passes, and the same facts freeze the same verdict", () => {
    const green = { state: "passed", headSha: "abc" };
    const failed = blindVerdict([item("hud")], new Map([["hud", fact("hud", { planFact: "failed" })]]), green, 1);
    expect(failed.state).toBe("failed");
    expect(failed.detail).toContain("hud: plan-fact failed — the promise is not proved");
    const proved = new Map([["hud", fact("hud")]]);
    const passed = blindVerdict([item("hud")], proved, green, 1);
    expect(passed).toMatchObject({ state: "passed", mainSha: "abc" });
    expect(blindVerdict([item("hud")], proved, green, 99).inputSha).toBe(passed.inputSha);
    expect(blindVerdict([item("hud")], new Map([["hud", fact("hud", { state: "blocked" })]]), green, 1).detail).toContain("hud not accepted");
    expect(blindVerdict([item("hud")], new Map([["hud", fact("hud", { codeCritique: "blocked" })]]), green, 1).detail).toContain("the code critic blocks it");
  });

  it("[sma:k_ag_integration] what was green on the base and is red on main after the merge is named, recorded on the baseline row and shown on the acceptance card", async () => {
    const w = await world();
    await w.services.baseline.preflight(w.pendingTask("t1", ["test -f keep.txt", "test -f feature.txt", "grep -q line2 server.ts"]));
    const turned = w.services.baseline.afterMerge({ runId: "run1", taskId: "t1", mergeCommit: "abc", checks: [
      { command: "test -f keep.txt", exitCode: 1 }, { command: "test -f feature.txt", exitCode: 1 }, { command: "grep -q line2 server.ts", exitCode: 1, hostError: true },
    ] });
    // keep.txt was green on the base and is red now; feature.txt was already red on the base (not this change's break); the host error proves nothing.
    expect(turned).toEqual(["test -f keep.txt"]);
    expect(getBaseline(w.db, "run1", "t1")!.after).toMatchObject({ turnedRed: ["test -f keep.txt"], mergeCommit: "abc", checked: 3 });
    expect(buildAcceptanceCard(w.db, { runId: "run1", taskId: "t1" })!.baseline!.turnedRed).toEqual(["test -f keep.txt"]);
    expect(w.services.baseline.afterMerge({ runId: "run1", taskId: "nope", checks: [] })).toEqual([]);
    await w.dispose();
  }, 180_000);
});
