import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { settleVerdict, verdictSchema } from "@lane-pilot/workflow-engine";
import { acceptanceProofGap } from "@lane-pilot/contracts";
import { taskV2Schema, type TaskV2 } from "../../src/rooms/contracts";
import { validateDocsEdits, type DocsPage } from "../../src/rooms/docs/docs";
import { acceptanceLines, designGate, nextAction, type Phase, type PhaseRecord } from "../../src/rooms/phase";
import { acceptanceKey } from "../../src/rooms/phase/logic";
import { CAPABILITIES, capabilityTable, dueProbes } from "../../src/rooms/capability";
import { conveyorState, setConveyor } from "../../src/rooms/conveyor";
import { pairApartFromWriter } from "../../src/rooms/critique/critic-pair";
import { pilotOf, type RunTask } from "../../src/rooms/pilot/logic";
import { failureClass, failureFingerprint, FREE_CLASSES, repeatedFailureReason, SESSION_MAX_TURNS } from "../../src/rooms/runs/failure-class";
import { MAIN_ATTEMPT_LIMIT, nextAttemptState, retryAction } from "../../src/rooms/runs/state-machine";
import { budgetStopReason, createRunBudget } from "@lane-pilot/resilience";
import {
  createAttempt, createRun, createTask, getAttempt, openDatabase, transitionAttempt,
} from "../../src/rooms/storage/database";
import { lintContract, lintReply, type LintInput } from "../../src/rooms/tasks/server/contract-lint";
import {
  HOLD_FOREVER, LANE_QUEUES, WORKER_ENVELOPE, birthFindings, deadLetters, laneQueueOf, ownerWordFindings, spendReserve, writerMarkers,
} from "../../src/rooms/tasks";
import { NO_CODE_KINDS, planFactOutcome, type PlanFactCheck } from "../../src/rooms/tasks/plan-fact";
import { needsHumanQuestion } from "../../src/rooms/writer/server/writer-task";
import { createWriterSticky } from "../../src/rooms/writer/server/sticky";
import { hookEnv } from "../hook-env";
import { useGuardSync } from "../guard-pool";

const root = "/tmp/sma-task";
const baseTask: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:sma", id: "sma-task", title: "SMA", risk: "low", lane: "writer", project_cwd: root,
  read_first: ["src/a.ts"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["src/b.ts"],
  owns_paths: ["src/"], never_touch: [".git/**"], depends_on: [], objective: "change a", acceptance: ["done"],
  verify: "tests", verification: [{ command: "npx vitest run tests/a.test.ts", cwd: root }],
};
const lint = (task: Partial<TaskV2> = {}, input: Partial<LintInput> = {}) =>
  lintContract({ task: { ...baseTask, ...task }, workspacePath: root, hostId: "h", sandboxUnsafe: [], openTasks: [], deadDependencies: [],
    kinds: new Map([[`${root}/src/a.ts`, "file"]]), ...input });

const finding = (over: Record<string, unknown> = {}) => ({ file: "src/a.ts", line: 12, severity: "high", evidence: "return null; // TODO: implement", ...over });
const verdict = (status: string, findings: unknown[]) => verdictSchema.parse({ status, findings, evidence: "read src/a.ts and the vitest output" });

const phase = (record: PhaseRecord, stage: Phase["stage"] = "design"): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

const guard = useGuardSync(join(process.cwd(), "lane-stack/hooks/guard_shell.py"));
const writerShell = (command: string) => guard({
  input: JSON.stringify({ agent_type: "writer", tool_name: "Bash", tool_input: { command }, cwd: process.cwd() }),
  env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
});

describe("spend, budget and a retry that stops itself", () => {
  it("[sma:ac_reserve] an unknown budget is not a zero reserve, and an appetite past the free tokens is refused", () => {
    expect(spendReserve({ budgetTokens: null, spentTokens: 40, openAppetites: [30], appetite: 1000 })).toEqual({ ok: true, free: null });
    expect(spendReserve({ budgetTokens: 100, spentTokens: 40, openAppetites: [30], appetite: 20 })).toMatchObject({ ok: true, free: 30 });
    const refused = spendReserve({ budgetTokens: 100, spentTokens: 40, openAppetites: [30], appetite: 31 });
    expect(refused.ok).toBe(false);
    expect(refused.free).toBe(30);
    expect(refused.why).toContain("31");
  });

  it("[sma:ac_next_budget] the next check is refused once the run is past its token limit, and that stop is not a charged retry", () => {
    const budget = createRunBudget({ maxTokens: 10 }, 0);
    expect(budget.check().ok).toBe(true);
    budget.noteTokens("thr_a", 11);
    const over = budget.check();
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.exceeded).toBe("maxTokens");
    expect(over.reason).toContain("run budget exceeded");
    expect(failureClass("blocked", budgetStopReason(over.exceeded))).toBe("budget");
    expect(FREE_CLASSES.has("budget")).toBe(true);
  });

  it("[sma:ae_retryable] [sma:av_unchanged] [sma:av_no_artifact] the same task failure twice stops; a different fault, a question and a budget stop do not", () => {
    const same = { state: "validation_failed", reason: "verification failed (npm test): boom in thr_aaa" };
    const again = { state: "validation_failed", reason: "verification failed (npm test): boom in thr_bbb" };
    expect(failureFingerprint(same.reason)).toBe(failureFingerprint(again.reason));
    expect(repeatedFailureReason(same, again)).toMatch(/^repeated_failure: /);
    expect(repeatedFailureReason(same, { state: "validation_failed", reason: "verification failed (npm test): other fault" })).toBeNull();
    expect(repeatedFailureReason(null, same)).toBeNull();
    const question = { state: "blocked", reason: "needs_human: which layout?" };
    expect(failureClass(question.state, question.reason)).toBe("judgment");
    expect(repeatedFailureReason(question, question)).toBeNull();
    const budget = { state: "blocked", reason: "run_budget_exceeded:tokens" };
    expect(repeatedFailureReason(budget, budget)).toBeNull();
  });

  it("[sma:ae_awaits] a NEEDS_HUMAN answer is the writer's question, and it is not sent around again", () => {
    const question = needsHumanQuestion("NEEDS_HUMAN: which file owns the tax?");
    expect(question?.toLowerCase()).toContain("which file");
    expect(needsHumanQuestion("`NEEDS_HUMAN: may I edit the check?`")).toContain("may I edit");
    expect(needsHumanQuestion("The tax file is src/tax.ts and the tests pass.")).toBeNull();
    expect(failureClass("blocked", "needs_human: which file")).toBe("judgment");
  });

  it("[sma:ap_turn_budget] once the session has spent its turn ceiling, the same writer is not launched again", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-turns", "proj");
    createTask(db, { id: "task-turns", runId: "run-turns", kind: "bb", contract: {} });
    const reason = "verification failed (npm test): boom";
    const stamp = (id: string) => {
      createAttempt(db, { id, runId: "run-turns", taskId: "task-turns" });
      transitionAttempt(db, id, "spawn_requested");
      transitionAttempt(db, id, "running", { threadId: "thr_same" });
      transitionAttempt(db, id, "validation_failed", { threadId: "thr_same", reason });
    };
    for (let n = 0; n < SESSION_MAX_TURNS - 1; n++) stamp(`turn-${n}`);
    const sticky = createWriterSticky({ bb, db } as never, {} as never);
    expect(sticky.sessionLimit(`turn-${SESSION_MAX_TURNS - 2}`)).toBeNull();
    stamp(`turn-${SESSION_MAX_TURNS - 1}`);
    expect(sticky.sessionLimit(`turn-${SESSION_MAX_TURNS - 1}`)).toBe(`turn limit ${SESSION_MAX_TURNS} reached`);
    expect(await sticky.retryWriter(`turn-${SESSION_MAX_TURNS - 1}`, "run-turns")).toBeNull();
    expect(retryAction("validation_failed", MAIN_ATTEMPT_LIMIT)).toBe("retry_exhausted");
    expect(nextAttemptState("validation_failed", "retry_exhausted")).toBe("blocked");
    await harness.lifecycle.dispose();
  });
});

describe("contract gates", () => {
  it("[sma:ag_deliverable] [sma:ap_blocker] a contract that leaves the project or its output is not dispatched, and the refusal names its class", () => {
    const unsafe = lint({ owns_paths: ["../outside"] });
    expect(unsafe.errors.map((error) => error.code)).toContain("ownership_unsafe");
    const unowned = lint({ expected_outputs: ["other/out.ts"] });
    expect(unowned.errors.map((error) => error.code)).toContain("output_unowned");
    const reply = lintReply("run-1", unsafe.errors);
    expect(reply.state).toBe("validation_failed");
    expect(String(reply.reason)).toContain("nothing was dispatched");
    expect(reply.blockingClasses).toContain("conflict");
  });

  it("[sma:tb_validate] an open clarification stops enqueue and is classed as missing information", () => {
    const open = lint({ clarify: { questions: ["Which currency?"], answers: [] } });
    expect(open.errors.map((error) => error.code)).toContain("clarify_open");
    expect(lintReply("run-1", open.errors).blockingClasses).toContain("missing_info");
  });

  it("[sma:cg_file_hold] two open tasks on the same declared files are told to wait, and the later one is not refused", () => {
    const overlap = lint({}, { openTasks: [{ id: "earlier", owns_paths: ["src/a.ts"], never_touch: [], depends_on: [] }] });
    expect(overlap.errors.map((error) => error.code)).not.toContain("owns_overlap_open");
    expect(overlap.warnings.map((warning) => warning.code)).toContain("owns_overlap_open");
    expect(overlap.warnings.find((warning) => warning.code === "owns_overlap_open")?.message).toContain("waits");
  });

  it("[sma:tb_promise] a promise that is missing a clause is refused; a medium feature with none is warned", () => {
    expect(birthFindings({ kind: "feature", risk: "low", promise: { given: "g", when: "", then: "t" } }).errors.map((error) => error.code)).toContain("promise_incomplete");
    expect(birthFindings({ kind: "feature", risk: "medium" }).warnings.map((warning) => warning.code)).toContain("promise_missing");
    expect(birthFindings({ kind: "feature", risk: "medium", promise: { given: "g", when: "w", then: "t" } }).warnings).toEqual([]);
  });

  it("[sma:ag_answer_gate] a research or check task with no code table is skipped; a feature with none fails", () => {
    const missing: PlanFactCheck = { table: "missing", tableReason: null, items: [], extraRows: [], blocking: [], notChecked: [] };
    expect(NO_CODE_KINDS.has("research")).toBe(true);
    expect(NO_CODE_KINDS.has("check")).toBe(true);
    expect(planFactOutcome(missing, !NO_CODE_KINDS.has("research")).state).toBe("skipped");
    expect(planFactOutcome(missing, !NO_CODE_KINDS.has("feature")).state).toBe("failed");
  });

  it("[sma:ap_envelope] the worker envelope has eight dimensions, and a contract that is not the schema is refused", () => {
    expect(Object.keys(WORKER_ENVELOPE)).toEqual(["files", "git", "shell", "secrets", "network", "tools", "time", "tokens"]);
    for (const text of Object.values(WORKER_ENVELOPE)) expect(text.length).toBeGreaterThan(10);
    expect(taskV2Schema.safeParse("not a contract").success).toBe(false);
    expect(taskV2Schema.safeParse({ ...baseTask, never_touch: "nope" }).success).toBe(false);
    expect(WORKER_ENVELOPE.git).toMatch(/push|merge/);
  });

  it("[sma:as_markers] the report's APPROACH and a LESSON of none with a reason are read off the text", () => {
    expect(writerMarkers("APPROACH: ship the check\nLESSON: none — the suite already covers it")).toEqual({
      approach: "ship the check", lesson: null, noLessonReason: "the suite already covers it",
    });
    expect(writerMarkers("done").approach).toBeNull();
  });
});

describe("phase gates and acceptance", () => {
  it("[sma:ag_design_gate] [sma:ap_batch_design_ready] a drawing step needs a feasible drawing reviewed by someone else", () => {
    expect(designGate({}).ok).toBe(false);
    expect(designGate({ design: { decision: "not_needed", why: "no screens" } }).ok).toBe(true);
    const record: PhaseRecord = { design: { decision: "needed", why: "screens", drawing: { paths: ["d.png"], sha256: "x", designer: "design-lead", feasible: true, reviewer: "design-lead" } } };
    const sameRole = designGate(record);
    expect(sameRole.ok).toBe(false);
    if (!sameRole.ok) expect(sameRole.why.join(" ")).toContain("separate role");
    record.design!.drawing!.reviewer = "ui-review";
    record.design!.drawing!.paths = ["d.png", ".agents/phases/ph_sma/design/UI-SPEC.md"];
    expect(designGate(record).ok).toBe(true);
    record.design!.drawing!.feasible = false;
    record.design!.drawing!.contradiction = "the plan has no screen";
    expect(designGate(record).ok).toBe(false);
  });

  it("[sma:ts_needs_clarify] an open question at design is answered before a drawing is asked for", () => {
    const record: PhaseRecord = { questions: [{ id: "q1", stage: "design", text: "Which grid?", blocking: true, askedAt: 1 }] };
    const action = nextAction(phase(record), new Map());
    expect(action.waitsForPm).toBe(true);
    expect(action.text).toContain("open question(s) at design");
    expect(action.text).toContain("Which grid?");
    expect(action.text).not.toContain("stage 3, design");
  });

  it("[sma:ta_decisions] with owner.words on, useful and limits are refused until that person says yes on this package", () => {
    const record: PhaseRecord = {
      ownerWords: true,
      plan: { items: [], sha: "plan", contextSha: "ctx", admittedSha: "plan" },
      verification: { verdict: { state: "passed", detail: "ok", mainSha: "abc", at: 1, inputSha: "in" } },
    };
    const line = (id: string, words = record.words) => acceptanceLines(phase({ ...record, words }, "acceptance"), new Map(), { mainSha: "abc", openDeferrals: 0 }).find((row) => row.id === id);
    expect(line("result_useful")?.ok).toBe(false);
    expect(line("limits_acknowledged")?.ok).toBe(false);
    const key = acceptanceKey(record);
    const yes = [{ turn: "acceptance" as const, decision: "yes" as const, by: "owner", text: "да", at: 1, useful: true, limits: true, key }];
    expect(line("result_useful", yes)?.ok).toBe(true);
    expect(line("limits_acknowledged", yes)?.ok).toBe(true);
    expect(line("result_useful", [{ ...yes[0]!, key: "other-package" }])?.ok).toBe(false);
    expect(line("result_useful", undefined)?.ok).toBe(false);
    const policy = acceptanceLines(phase({ ...record, ownerWords: false }, "acceptance"), new Map(), { mainSha: "abc", openDeferrals: 0 });
    expect(policy.find((row) => row.id === "result_useful")?.ok).toBe(true);
  });

  it("[sma:f_inv_accept] [sma:ta_unverified] acceptance needs a code proof; opinion stages alone are refused", () => {
    expect(acceptanceProofGap(["plan-critique", "code-critique"])).toMatch(/acceptance_without_code_proof/);
    expect(acceptanceProofGap([])).toMatch(/no stage passed/);
    expect(acceptanceProofGap(["verification"])).toBeNull();
    expect(ownerWordFindings({ clarify: { answers: [{ question: "colour?", by: "pm" }] } }, true)[0]?.code).toBe("clarify_needs_owner");
    expect(ownerWordFindings({ clarify: { answers: [{ question: "colour?", by: "owner" }] } }, true)).toEqual([]);
  });

  it("[sma:av_admission] [sma:av_blocks] a hard critical finding blocks, and a pass that hides a high finding is a rework", () => {
    const hard = settleVerdict(verdict("rework", [finding({ severity: "critical", dimension: "security", evidence: "the query is built from the request body without a check" })]), "code");
    expect(hard.verdict.status).toBe("block");
    expect(settleVerdict(verdict("pass", [finding()]), "code").verdict.status).toBe("rework");
  });

  it("[sma:av_minor] medium findings do not block acceptance", () => {
    expect(settleVerdict(verdict("rework", [finding({ severity: "medium", evidence: "the name is a bit vague here" })]), "code").verdict.status).toBe("pass");
    expect(settleVerdict(verdict("block", [finding({ severity: "low", evidence: "a comment could be clearer" })]), "code").verdict.status).toBe("pass");
  });

  it("[sma:av_critic_route] the critic moves off the writer's pair when another catalog pair works, and the same pair is kept when it is the only one", async () => {
    const catalog = {
      provider: async (id: string) => ({ id, available: true, supportsServiceTier: false, serviceTiers: [] as string[] }),
      models: async (id: string) => [{ id: id === "other" ? "m2" : "m1", model: id === "other" ? "m2" : "m1", efforts: ["medium"] }],
    };
    const writer = { providerId: "w", model: "m1" };
    const moved = await pairApartFromWriter({ current: writer, writer, candidates: [{ providerId: "other", model: "m2" }], effort: "medium", tier: "standard", catalog });
    expect(moved).toEqual({ pair: { providerId: "other", model: "m2" }, changed: true });
    const kept = await pairApartFromWriter({ current: writer, writer, candidates: [writer], effort: "medium", tier: "standard", catalog });
    expect(kept).toEqual({ pair: writer, changed: false });
  });
});

describe("queue, docs, capabilities, conveyor, pilot", () => {
  it("[sma:ag_doc_gate] a docs edit whose hash or path is not the selected page is refused", () => {
    const sha = "a".repeat(64);
    const page: DocsPage = { path: "docs/a.md", modifiedAt: 1, sha256: sha, content: "hello" };
    expect(validateDocsEdits([{ path: "docs/a.md", expectedSha256: sha, content: "# A\n" }], [page], 10)).toEqual([{ path: "docs/a.md", expectedSha256: sha, content: "# A\n" }]);
    expect(() => validateDocsEdits([{ path: "docs/a.md", expectedSha256: "b".repeat(64), content: "x" }], [page], 10)).toThrow(/hash/);
    expect(() => validateDocsEdits([{ path: "docs/other.md", expectedSha256: sha, content: "x" }], [page], 10)).toThrow(/outside/);
    expect(() => validateDocsEdits([{ path: "src/a.ts", expectedSha256: sha, content: "x" }], [page], 10)).toThrow(/docs\/ or apps\//);
  });

  it("[sma:tr_dead] [sma:tr_lanes] a blocked row is a dead letter only after a day, and the four lanes do not share a queue", () => {
    const now = 10_000_000;
    const day = 86_400_000;
    expect(deadLetters([{ state: "blocked", updatedAt: now - day }, { state: "blocked", updatedAt: now - day + 1 }, { state: "accepted", updatedAt: now - day * 2 }], now).map((row) => row.state)).toEqual(["blocked"]);
    expect(laneQueueOf("feature")).toBe("write");
    expect(laneQueueOf("check")).toBe("check");
    expect(laneQueueOf("docs")).toBe("docs");
    expect(laneQueueOf("research")).toBe("research");
    expect(LANE_QUEUES).toEqual(["write", "check", "docs", "research"]);
  });

  it("[sma:tb_gate_hold] [sma:ts_held] a new task is not held, and a hold with no date sits at year 2999, which is still in the future", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-hold", "proj");
    createTask(db, { id: "task-hold", runId: "run-hold", kind: "bb", contract: {} });
    const fresh = db.prepare("SELECT held_until FROM lane_pilot_task WHERE id=?").get("task-hold") as { held_until: number | null };
    expect(fresh.held_until).toBeNull();
    db.prepare("UPDATE lane_pilot_task SET held_until=? WHERE id=?").run(HOLD_FOREVER, "task-hold");
    const held = (db.prepare("SELECT held_until FROM lane_pilot_task WHERE id=?").get("task-hold") as { held_until: number }).held_until;
    expect(held).toBe(Date.UTC(2999, 0, 1));
    expect(held > Date.now()).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("[sma:cg_batch_turn] the third sibling waits for the earliest, and two siblings or an ordered task do not", () => {
    const tasks: RunTask[] = [1, 2, 3].map((n) => ({ id: `p${n}`, area: "page", kind: "feature", createdAt: n, dependsOn: [] }));
    expect(pilotOf("p1", tasks)).toBeNull();
    expect(pilotOf("p3", tasks)).toBe("p1");
    expect(pilotOf("p2", tasks.slice(0, 2))).toBeNull();
    expect(pilotOf("p3", tasks.map((task) => task.id === "p3" ? { ...task, dependsOn: ["p1"] } : task))).toBeNull();
  });

  it("[sma:ap_caps] a provider whose adapter version has no receipt is unproven and due for a probe; a full receipt is not", () => {
    const inUse = new Map([["codex", "gpt"]]);
    const versions = new Map([["codex", "1.2.3"]]);
    expect(dueProbes(inUse, versions, [])).toEqual([{ providerId: "codex", model: "gpt", version: "1.2.3" }]);
    expect(capabilityTable(inUse, versions, [])[0]?.capabilities.documentary).toBe("unproven");
    const receipts = CAPABILITIES.map((capability) => ({ providerId: "codex", version: "1.2.3", capability, state: "supported" as const, model: "gpt", detail: null, at: 1 }));
    expect(dueProbes(inUse, versions, receipts)).toEqual([]);
  });

  it("[sma:ap_switched_off] the conveyor is on until it is switched off, and a reload of that store keeps it off", async () => {
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } };
    expect(await conveyorState(kv)).toEqual({ on: true, since: null, reason: null });
    const off = await setConveyor(kv, false, "maintenance");
    expect(off.on).toBe(false);
    expect(off.reason).toBe("maintenance");
    expect((await conveyorState(kv)).on).toBe(false);
    expect((await setConveyor(kv, true)).on).toBe(true);
  });
});

describe("attempt ledger", () => {
  it("[sma:f_ready] [sma:f_claimed] [sma:f_running] [sma:f_produced] [sma:f_accepted] [sma:f_cancelled] [sma:f_retryable] the ledger stamps the attempt states, and an accepted row is not overwritten", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-ledger", "proj");
    createTask(db, { id: "task-ledger", runId: "run-ledger", kind: "bb", contract: {} });
    createAttempt(db, { id: "a-ready", runId: "run-ledger", taskId: "task-ledger" });
    expect(getAttempt(db, "a-ready")).toMatchObject({ state: "queued", attempt_no: 1 });
    expect(nextAttemptState(null, "form_task")).toBe("queued");
    transitionAttempt(db, "a-ready", "spawn_requested");
    expect(getAttempt(db, "a-ready")?.state).toBe("spawn_requested");
    transitionAttempt(db, "a-ready", "running", { threadId: "thr_w" });
    expect(getAttempt(db, "a-ready")?.state).toBe("running");
    transitionAttempt(db, "a-ready", "accepted");
    expect(getAttempt(db, "a-ready")?.state).toBe("accepted");
    expect(transitionAttempt(db, "a-ready", "canceled", { reason: "late cancel" })).toBe(false);
    expect(getAttempt(db, "a-ready")?.state).toBe("accepted");

    createAttempt(db, { id: "a-stop", runId: "run-ledger", taskId: "task-ledger" });
    expect(getAttempt(db, "a-stop")?.attempt_no).toBe(2);
    transitionAttempt(db, "a-stop", "spawn_requested");
    transitionAttempt(db, "a-stop", "running");
    transitionAttempt(db, "a-stop", "cancel_requested");
    transitionAttempt(db, "a-stop", "canceled");
    expect(getAttempt(db, "a-stop")?.state).toBe("canceled");
    expect(nextAttemptState("cancel_requested", "cancel_observed")).toBe("canceled");
    expect(retryAction("validation_failed", 1)).toBe("retry");
    expect(nextAttemptState("validation_failed", "retry")).toBe("queued");
    await harness.lifecycle.dispose();
  });

  it("[sma:f_inv_push] a writer shell is not granted git push or git merge; status and a mention inside a heredoc still run", () => {
    for (const command of ["git push origin main", "git merge main", "git -C /tmp/repo push"]) {
      const result = writerShell(command);
      expect(result.status, command).toBe(2);
      expect(result.stdout).toContain("not granted git push or git merge");
    }
    expect(writerShell("git status").status).toBe(0);
    expect(writerShell("python3 - <<'EOF'\nprint('git push origin main')\nEOF").status).toBe(0);
  });
});

describe("gaps the code does not keep", () => {
  it.todo("[sma:ac_open] registration stores a token, ceilings and action kinds");
  it.todo("[sma:ac_pocket] an exhausted batch budget asks the owner");
  it.todo("[sma:tb_contract] a word change mints a numbered hashed contract edition and keeps the history");
  it.todo("[sma:tr_token] a stale worker cannot close somebody else's fresh attempt");
  it.todo("[sma:f_verifying] [sma:f_waiting_human] [sma:f_rejected] [sma:f_dead_letter] the ledger stamps these attempt states");
  it.todo("[sma:av_test_edit_hold] an unauthorised reference-test edit holds the hand-in until a person allows it");
  it.todo("[sma:ag_doc_gate] the document stage also checks that its roles ran separately");
  it.todo("[sma:ap_caps] a documentary stage cannot run while that capability is unproven");
  it.todo("[sma:ap_caps_held] a probe that fails in its own setup holds the row");
  it.todo("[sma:ts_needs_clarify] a batch service drawing may proceed while other words are still open");
});
