// Region 1 · Task graph — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. The lines below are the
// framework's worked examples (2026-11-14): each mutation was killed by a real `npm run sma:mutate` run
// (attest/r01.json) and each trace was run on the hub snapshot of the same day.
import { distort, drill, entry, flip, gate, isSet, outside, receipt, type RegionEvidence, rows, settingRow, transition, via, voidIsHave, wrongTarget } from "./types";

const TASK_HOME = "src/rooms/writer/server/task-home.ts";

export default {
  n158: {
    mutation: distort("src/rooms/storage/attempts-store/lifecycle.ts", '"queued", used + 1, now, now, HARNESS_VERSION);', '"queued", used + 2, now, now, HARNESS_VERSION);'),
    trace: rows("lane_pilot_attempt", "created_at"),
    voidReview: voidIsHave("регистрация попытки — строка lane_pilot_attempt (id-токен, номер растёт) плюс замороженный run_policy_json с потолками (maxTurns, пулы); виды действий задаёт контракт задачи"),
  },
  n159: {
    mutation: flip("src/rooms/stability/server/reconcile.ts", 'if (attempt.state !== "cancel_requested") transitionAttempt(db, attempt.id, "running", { threadId:result.threadId });', 'if (attempt.state === "cancel_requested") transitionAttempt(db, attempt.id, "running", { threadId:result.threadId });'),
    trace: transition({ from: "spawn_unknown", to: "spawn_rejected", reason: "reconcile completed" }),
  },
  n160: {
    mutation: distort("src/rooms/writer/server/spawn.ts", '"spawn_unknown", { reason:cause instanceof Error ? cause.message : String(cause) });', '"spawn_unknown", { reason:"spawn failed" });'),
    trace: transition({ from: "spawn_requested", to: "spawn_unknown" }),
  },
  n161: {
    mutation: flip("src/rooms/writer/server/start-admission.ts", "return reserve.ok ? null : `permit_refused:reserve: ${reserve.why}`;", "return !reserve.ok ? null : `permit_refused:reserve: ${reserve.why}`;"),
    // The permit only holds a price while the run has a token budget: no hub row sets run.max_tokens, so it is unreachable today, honestly.
    reach: via({ "run.max_tokens": isSet() }),
    trace: drill("sma_r01"),
  },
  n162: {
    mutation: distort("src/rooms/tasks/rails.ts", "if (input.budgetTokens === null) return { ok: true, free: null };", "if (input.budgetTokens === null) return { ok: true, free: 0 };"),
    reach: via({ "run.max_tokens": isSet() }),
    trace: drill("sma_r01"),
  },
  n163: {
    mutation: distort("src/rooms/rollback/store.ts", 'if (change.worktree?.read === "failed") return "uncertain";', 'if (change.worktree?.read === "failed") return "observed";'),
    trace: rows("lane_pilot_attempt_change", "updated_at"),
  },
  n164: {
    mutation: flip("src/rooms/rollback/store.ts", 'if (revert && (revert.state === "failed" || revert.state === "error")) return "rollback_failed";', 'if (revert && (revert.state === "failed" && revert.state === "error")) return "rollback_failed";'),
    reach: entry("a task is sent again or retried after an attempt whose spawn is unknown, whose revert failed or that waits on a question"),
    trace: rows("lane_pilot_attempt", "updated_at", "state = 'blocked' AND reason LIKE 'needs_human%'"),
  },
  n165: {
    mutation: flip("src/rooms/writer/server/watch-writer.ts", "if (timeUsed < 0.8) return;", "if (timeUsed > 0.8) return;"),
    trace: drill("sma_r01"),
  },
  n166: {
    mutation: wrongTarget("src/rooms/writer/server/start-attempt-loop.ts", 'postOwnerItem(db, { key:`run-budget:${input.runId}`, source:"writer"', 'postOwnerItem(db, { key:`run-budget:${input.taskId}`, source:"writer"'),
    reach: via({ "run.max_tokens": isSet() }),
    trace: drill("sma_r01"),
  },
  n167: {
    mutation: distort("src/rooms/baseline/server/baseline.ts", '{ status: row.ok ? "green" : "red", exitCode: row.exitCode,', '{ status: row.ok ? "red" : "green", exitCode: row.exitCode,'),
    trace: rows("lane_pilot_baseline", "at", "state = 'ran'"),
  },
  n168: {
    mutation: flip("src/rooms/baseline/server/baseline.ts", "&& outside.length > 0 && ownerAnsweredItem(db as never, redItemKey);", "&& outside.length > 0 && !ownerAnsweredItem(db as never, redItemKey);"),
    trace: drill("sma_r01"),
  },
  n169: {
    mutation: wrongTarget("packages/resilience/src/budget.ts", "maxWallMs: now - startedAt, maxTokens: tokens()", "maxWallMs: now - startedAt, maxTokens: children"),
    // The limit does nothing while run.max_tokens is empty — and no hub row sets it: unreachable today, honestly.
    reach: via({ "run.max_tokens": isSet() }),
    trace: transition({ to: "blocked", reason: "run_budget_exceeded" }),
  },
  n170: {
    mutation: flip("src/rooms/host-worker/handlers/machine.ts", "if (await stat(join(root, session, `${id}.answer.json`)).then(() => true, () => false)) continue;", "if (await stat(join(root, session, `${id}.answer.json`)).then(() => false, () => true)) continue;"),
    trace: drill("sma_r01"),
  },
  n171: {
    mutation: wrongTarget("src/rooms/writer/server/finish.ts", 'scope:"attempt", projectId:input.projectId, runId:input.runId, taskId:input.taskId,', 'scope:"attempt", projectId:input.projectId, runId:input.runId, taskId:input.runId,'),
    trace: receipt("acceptance-receipt", "passed"),
  },
  n172: {
    mutation: distort("src/rooms/storage/attempts-store/transition.ts", ".run(state, fields.threadId ?? null, fields.reason ?? null, fields.failureCode ?? null,", ".run(state, fields.threadId ?? null, fields.reason ?? null, null,"),
    trace: rows("lane_pilot_attempt", "updated_at", "failure_code IS NOT NULL"),
  },
  n173: {
    mutation: distort("src/rooms/contracts/failure-class.ts", '|| PERMIT_REFUSED.test(text)) return sure("budget");', '|| PERMIT_REFUSED.test(text)) return sure("limit");'),
    trace: rows("lane_pilot_attempt", "updated_at", "failure_code IS NOT NULL"),
  },
  n174: {
    mutation: distort("src/rooms/writer/server/writer-task.ts", '.replace(/\\s+/g, " ").trim().slice(0, 600);', '.replace(/\\s+/g, " ").trim().slice(0, 6);'),
    trace: rows("lane_pilot_attempt", "updated_at", "state = 'blocked' AND reason LIKE 'needs_human%'"),
  },
  n175: {
    mutation: flip("src/rooms/contracts/failure-class.ts", "if (cls !== \"task\" && cls !== \"contract\") return null;", "if (cls !== \"task\" || cls !== \"contract\") return null;"),
    trace: transition({ to: "blocked", reason: "repeated_failure:" }),
  },
  n176: {
    mutation: distort("src/rooms/contracts/failure-class.ts", "2 ** Math.max(0, sameClassStreak - 1)", "2 ** Math.max(0, sameClassStreak - 2)"),
    trace: drill("sma_r01"),
  },
  n177: {
    mutation: flip("src/rooms/writer/server/start-failure-route.ts", "if (countChargedAttempts(db, input.runId, input.taskId) >= MAIN_ATTEMPT_LIMIT", "if (countChargedAttempts(db, input.runId, input.taskId) > MAIN_ATTEMPT_LIMIT"),
    trace: transition({ to: "blocked", reason: "retry limit 2 exhausted" }),
  },
  n178: {
    mutation: flip("src/rooms/writer/server/start-failure-route.ts", "if (PARKED_CLASSES.has(failedClass) || isWaitingSecret(", "if (!PARKED_CLASSES.has(failedClass) || isWaitingSecret("),
    trace: drill("sma_r01"),
  },
  n179: {
    mutation: flip("src/rooms/contracts/failure-class.ts", 'if (state === "empty_output") return sure(text.includes(NO_ANSWER_REASON) ? "provider" : "task");', 'if (state === "empty_output") return sure(text.includes(NO_ANSWER_REASON) ? "task" : "provider");'),
    reach: entry("a writer's thread ends in error or answers nothing"),
    trace: transition({ to: "provider_error" }),
  },
  n180: {
    mutation: flip("src/rooms/writer/server/attempt-reactions.ts", "if (!accepted && !FAILED_LESSON_STATES.has(event.status)) return;", "if (!accepted && FAILED_LESSON_STATES.has(event.status)) return;"),
    trace: rows("lane_pilot_rule_proposal", "first_seen_at", "author LIKE 'writer%'"),
  },
  n181: {
    mutation: distort("src/rooms/verification/git-integrate/merge.ts", 'if(merged.ok) return {status:"merged",commit:(await git(basePath,["rev-parse","HEAD"])).stdout.trim()||null', 'if(merged.ok) return {status:"merged",commit:(await git(basePath,["rev-parse","HEAD~1"])).stdout.trim()||null'),
    trace: rows("lane_pilot_attempt_change", "updated_at", "outcome = 'merged'"),
  },
  n182: {
    mutation: flip("src/rooms/writer/server/writer-task.ts", 'if (text.startsWith("diff --git") || text.startsWith("--- ")) return text;', 'if (text.startsWith("diff --git") && text.startsWith("--- ")) return text;'),
    trace: settingRow("writer.lastPatch"),
  },
  n183: {
    mutation: flip("src/rooms/baseline/server/baseline.ts", "if (allGreen && closesWhenAlreadyGreen(settings.requireRed, input.task)) {", "if (!allGreen && closesWhenAlreadyGreen(settings.requireRed, input.task)) {"),
    trace: rows("lane_pilot_baseline", "at", "summary LIKE 'already done:%'"),
  },
  n184: {
    mutation: distort("src/rooms/contracts/failure-class.ts", 'if (!CHECK_FAILED.test(text) && NON_WORK.test(text)) return sure("provider");', 'if (!CHECK_FAILED.test(text) && NON_WORK.test(text)) return sure("task");'),
    trace: drill("sma_r01"),
  },
  n185: {
    mutation: distort("src/rooms/writer/server/reassign.ts", 'cancelCode: "reassign" });', 'cancelCode: "stopped" });'),
    trace: rows("lane_pilot_attempt", "updated_at", "cancel_code = 'reassign'"),
  },
  n186: {
    mutation: flip("src/rooms/verification/git-integrate/merge.ts", "if(dirty.stdout.trim()) {", "if(!dirty.stdout.trim()) {"),
    trace: drill("sma_r01"),
  },
  n187: {
    mutation: flip("src/rooms/phase/logic/design.ts", "else if (drawing.reviewer === drawing.designer) why.push(", "else if (drawing.reviewer !== drawing.designer) why.push("),
    trace: drill("sma_r01"),
  },
  n188: {
    mutation: flip("src/rooms/writer/server/finish-attempt-body.ts", "if (parkedWorkspace) {", "if (!parkedWorkspace) {"),
    trace: gate("accept", "skipped"),
  },
  n189: {
    mutation: flip("src/rooms/docs/docs.ts", "if (edit.expectedSha256 !== expectedSha256) throw", "if (edit.expectedSha256 === expectedSha256) throw"),
    trace: drill("sma_r01"),
  },
  n197: {
    mutation: distort("src/rooms/tasks/rails.ts", "/^(M|D|R)/.test(change.status)", "/^(M|R)/.test(change.status)"),
    trace: transition({ to: "blocked", reason: "test_fit" }),
  },
  n202: {
    mutation: distort("src/rooms/contracts/failure-class.ts", "if (MERGE.test(text)) return sure(\"merge\");", "if (MERGE.test(text)) return sure(\"task\");"),
    trace: rows("lane_pilot_attempt", "updated_at", "failure_code IS NOT NULL"),
  },
  n230: { voidReview: voidIsHave("личный слой основателя зеркалится: запуск сливает хуки, защиту и запреты человека в копию настроек каждого помощника и писателя, нечитаемый хук снимается с причиной (docs/guide/hooks.md, правило 6)") },
  // One folder per attempt in the task home: barrier-input, checks, report under attempts/<attempt-id>/ (docs/task-folder.md, T9, T11).
  n233: { mutation: wrongTarget(TASK_HOME, 'name: `attempts/${input.attemptId}/barrier-input.json`', 'name: "barrier-input.json"'), reach: entry("a writer attempt of a task with a home runs its checks and code critique"), trace: drill("task_home") },
  // The PM's plan reaches the writer as text: shared .agents/plans/* files it names are snapshotted into context/plan-source.md (T1).
  n236: { mutation: flip(TASK_HOME, "if (sources.length) files.push(", "if (!sources.length) files.push("), reach: entry("a PM dispatches a task whose plan names shared .agents/plans files"), trace: drill("task_home") },
  n251: {
    mutation: wrongTarget("src/rooms/tasks/rails.ts", "return { approach: line(\"APPROACH\")", "return { approach: line(\"LESSON\")"),
    trace: outside("the markers are read off the writer's answer in finish-attempt-body; only their warnings reach the BB thread"),
  },
  n252: {
    mutation: distort("src/rooms/tasks/rails.ts", "|| \"no reason given\" : null;", "|| \"none\" : null;"),
    trace: outside("a lesson is filed as a writer proposal from the answer text; the plugin database keeps no per-answer marker row"),
  },
  n266: {
    mutation: flip("packages/workflow-engine/src/verdict.ts", "const blocks = hard >= 1 || high > 5;", "const blocks = hard > 1 || high > 5;"),
    trace: gate("accept", ["passed", "rejected"]),
  },
  n267: {
    mutation: flip("packages/workflow-engine/src/verdict.ts", "if (status === \"rework\" && high + critical === 0) status = \"pass\";", "if (status === \"rework\" && high + critical !== 0) status = \"pass\";"),
    trace: receipt("code-critique", "pass"),
  },
  // The accepted attempt's receipts are written once into the task home in the base, so they outlive the worktree's removal (T13).
  n294: { mutation: wrongTarget(TASK_HOME, 'kind: "acceptance", name: "acceptance.json",', 'kind: "acceptance", name: `attempts/${input.attemptId}/acceptance.json`,'), trace: drill("task_home") },
  n300: { reach: entry("a PM or the owner enqueues a task contract") },
  n306: {
    mutation: distort("src/rooms/tasks/rails.ts", "held)/.test(code)) return \"dependency\";", "held)/.test(code)) return \"conflict\";"),
    trace: transition({ to: "blocked", reason: "depends_on" }),
  },
  n317: { voidReview: voidIsHave("состояние «заявлена» = попытка spawn_requested/running с живым циклом в activeWriterTasks; без живого цикла её забирает периодический проход (аренда = живой цикл)") },
  n329: {
    mutation: flip("src/rooms/tasks/rails.ts", "|| a.queuedAt - b.queuedAt);", "|| b.queuedAt - a.queuedAt);"),
    trace: transition({ from: "queued", to: "spawn_requested" }),
  },
} satisfies RegionEvidence;
