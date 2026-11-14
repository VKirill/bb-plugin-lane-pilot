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
    reach: entry("a task with promised checks is started"),
    // The checks run in the start flow of a task that promised checks: the entry is the dispatch of such a task (its predecessor, the permit n161, waits for run.max_tokens).
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
    trace: [rows("lane_pilot_attempt", "updated_at", "state = 'blocked' AND reason LIKE 'needs_human%'"), drill("sma_r01")],
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
    trace: rows("lane_pilot_rule_proposal", "updated_at", "signature LIKE 'lesson::%' AND examples_json LIKE '%failed attempt %'"),
  },
  n181: {
    mutation: distort("src/rooms/verification/git-integrate/merge.ts", 'if(merged.ok) return {status:"merged",commit:(await git(basePath,["rev-parse","HEAD"])).stdout.trim()||null', 'if(merged.ok) return {status:"merged",commit:(await git(basePath,["rev-parse","HEAD~1"])).stdout.trim()||null'),
    trace: [rows("lane_pilot_attempt_change", "updated_at", "outcome = 'merged'"), drill("sma_r01")],
  },
  n182: {
    mutation: flip("src/rooms/writer/server/writer-task.ts", 'if (text.startsWith("diff --git") || text.startsWith("--- ")) return text;', 'if (text.startsWith("diff --git") && text.startsWith("--- ")) return text;'),
    trace: settingRow("writer.lastPatch"),
  },
  n183: {
    mutation: flip("src/rooms/baseline/server/baseline.ts", "if (allGreen && closesWhenAlreadyGreen(settings.requireRed, input.task)) {", "if (!allGreen && closesWhenAlreadyGreen(settings.requireRed, input.task)) {"),
    trace: rows("lane_pilot_baseline", "at", "action = 'notified'"),
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
    trace: [gate("accept", "skipped"), drill("sma_r01")],
  },
  n189: {
    mutation: flip("src/rooms/docs/docs.ts", "if (edit.expectedSha256 !== expectedSha256) throw", "if (edit.expectedSha256 === expectedSha256) throw"),
    trace: drill("sma_r01"),
  },
  n190: {
    mutation: distort("src/rooms/tasks/plan-fact.ts", 'new Set(["docs", "research", "check"])', 'new Set(["docs", "check"])'),
    trace: receipt("plan-fact", "skipped"),
  },
  n191: {
    mutation: distort("src/rooms/baseline/server/baseline.ts", "не запущена: ${vacuousMessage(", "запущена: ${vacuousMessage("),
    trace: rows("lane_pilot_baseline", "at", "action = 'stopped' AND summary LIKE '%no check is red%'"),
  },
  n192: {
    mutation: distort("src/rooms/runs/server/stage-records.ts", "const barrier={gate:input.gate,status:input.status,reason,", 'const barrier={gate:input.gate,status:"passed",reason,'),
    trace: gate("accept", "skipped"),
  },
  n193: {
    mutation: flip("src/rooms/baseline/logic.ts", 'const green = new Set(baseline.filter((check) => check.status === "green")', 'const green = new Set(baseline.filter((check) => check.status === "red")'),
    trace: rows("lane_pilot_baseline", "at", "after_json IS NOT NULL"),
  },
  n194: {
    mutation: flip("src/rooms/tasks/validate-output.ts", 'if (input.task.verify !== "none" && input.task.verification.length === 0) {', 'if (input.task.verify === "none" && input.task.verification.length === 0) {'),
    trace: drill("sma_r01"),
  },
  n195: {
    mutation: distort("src/rooms/rollback/server/rollback.ts", "baseSha: state.base, outcome: input.outcome, changed: state.changed,", "baseSha: state.base, outcome: input.outcome, changed: state.changed.slice(1),"),
    trace: rows("lane_pilot_attempt_change", "updated_at", "changed_json <> '[]'"),
  },
  n196: {
    mutation: flip("src/rooms/writer/server/execution-checklist.ts", ".filter((item) => !item.evidence)", ".filter((item) => item.evidence)"),
    trace: drill("sma_r01"),
  },
  n197: {
    mutation: distort("src/rooms/tasks/rails.ts", "/^(M|D|R)/.test(change.status)", "/^(M|R)/.test(change.status)"),
    trace: transition({ to: "blocked", reason: "test_fit" }),
  },
  n198: {
    mutation: flip("src/rooms/tasks/rails.ts", "if (!test.imports.length) flags.push(", "if (test.imports.length) flags.push("),
    trace: drill("sma_r01"),
  },
  n199: {
    mutation: distort("src/rooms/tasks/validate-output.ts", "return !produced.includes(path) || content === null || content === undefined;", "return !produced.includes(path) && (content === null || content === undefined);"),
    trace: transition({ to: "empty_output" }),
  },
  n200: {
    mutation: distort("src/rooms/tasks/server/contract-lint.ts", "for (const entry of unownedExpectedOutputs(task).slice(0, 5)) {", "for (const entry of unownedExpectedOutputs(task).slice(1, 5)) {"),
    trace: drill("sma_r01"),
  },
  n201: {
    mutation: flip("src/rooms/contracts/failure-class.ts", "return ENVIRONMENT_LINE.test(output) && !TEST_REPORT_RED.test(report);", "return ENVIRONMENT_LINE.test(output) && TEST_REPORT_RED.test(report);"),
    trace: rows("lane_pilot_attempt", "updated_at", "reason LIKE '%environment: %'"),
  },
  n202: {
    mutation: distort("src/rooms/contracts/failure-class.ts", "if (MERGE.test(text)) return sure(\"merge\");", "if (MERGE.test(text)) return sure(\"task\");"),
    trace: rows("lane_pilot_attempt", "updated_at", "failure_code IS NOT NULL"),
  },
  n203: {
    mutation: distort("src/rooms/storage/attempts-store/lifecycle.ts", '.run(ids.id, ids.runId, ids.taskId, "queued", used + 1, now, now, HARNESS_VERSION);', '.run(ids.id, ids.runId, ids.taskId, "queued", used + 2, now, now, HARNESS_VERSION);'),
    trace: rows("lane_pilot_attempt", "created_at", "attempt_no > 1"),
  },
  n204: {
    mutation: flip("src/rooms/runs/server/stage-records.ts", 'if (current && ["failed", "blocked", "skipped"].includes(current.state)) recordStage(db, { runId, taskId, stageId, state:"pending", input:plan, reason, reopen:true });', 'if (current && ["blocked", "skipped"].includes(current.state)) recordStage(db, { runId, taskId, stageId, state:"pending", input:plan, reason, reopen:true });'),
    trace: drill("sma_r01"),
  },
  n205: {
    mutation: flip("packages/models/src/writer-fallbacks.ts", "if (!item.providerId || !item.model || seen.has(key)) continue;", "if (!item.providerId || !item.model) continue;"),
    trace: drill("sma_r01"),
  },
  n206: {
    mutation: wrongTarget("src/rooms/writer/server/writer-hold.ts", "else if (!free) free = { member, index };", "else free = { member, index };"),
    trace: drill("sma_r01"),
  },
  n207: {
    mutation: flip("src/rooms/contracts/failure-class.ts", "usage_window|owner_present|writer_off", "usage_window|writer_off"),
    trace: transition({ to: "spawn_rejected", reason: "writer_provider_unavailable:" }),
  },
  n208: {
    mutation: wrongTarget("src/rooms/writer/server/start-writer-holds.ts", "const held = walk.shortest!.hold;", "const held = walk.holds[walk.holds.length - 1]!.hold;"),
    trace: transition({ from: "queued", to: "queued", reason: "waiting_writer:" }),
  },
  n209: {
    mutation: flip("src/rooms/storage/attempts-store/lifecycle.ts", "WHERE id=? AND holder_thread_id IS NULL AND thread_id IS NULL", "WHERE id=? AND thread_id IS NULL"),
    trace: drill("sma_r01"),
  },
  n210: {
    mutation: flip("src/rooms/tasks/rails.ts", "owns_overlap|ownership_|never_touch", "owns_overlap|ownership-|never_touch"),
    trace: drill("sma_r01"),
  },
  n211: {
    mutation: flip("src/rooms/capability/logic.ts", 'if (result.answered === true || /helper_probe_\\w+?_(unexpected|check_failed)|helper_probe_wrote/.test(reason)) return "wrong";', 'if (result.answered === false || /helper_probe_\\w+?_(unexpected|check_failed)|helper_probe_wrote/.test(reason)) return "wrong";'),
    trace: rows("lane_pilot_capability", "at"),
  },
  n212: {
    mutation: distort("src/rooms/capability/logic.ts", "/Parent thread is invalid|", "/Parent thread is valid|"),
    trace: rows("lane_pilot_capability", "at", "state = 'not_supported'"),
  },
  n213: {
    mutation: wrongTarget("src/rooms/forge/server/index.ts", "owns_paths: [`${draftFolder(input.kind, input.name)}/`]", 'owns_paths: [`${draftFolder(input.kind, "x")}/`]'),
    trace: drill("sma_r01"),
  },
  n214: {
    mutation: flip("src/rooms/tasks/server/contract-lint.ts", 'else if (!kin && confirmed.length) errors.push({ code:"drawing_kin"', 'else if (kin && confirmed.length) errors.push({ code:"drawing_kin"'),
    trace: drill("sma_r01"),
  },
  n215: {
    mutation: flip("src/rooms/phase/logic/design.ts", "else if (drawing.reviewer === drawing.designer) why.push(", "else if (drawing.reviewer !== drawing.designer) why.push("),
    trace: drill("sma_r01"),
  },
  n216: {
    mutation: flip("src/rooms/baseline/logic.ts", 'if (setting === "off" || !task.kind || !ALREADY_DONE_KINDS.includes(task.kind)) return false;', 'if (setting === "off" || !task.kind || ALREADY_DONE_KINDS.includes(task.kind)) return false;'),
    trace: rows("lane_pilot_baseline", "at", "verdict = 'already_built' AND action = 'notified'"),
  },
  n217: {
    mutation: flip("src/rooms/writer/server/start-writer-holds.ts", "if (walk.allUnsupported) {", "if (!walk.allUnsupported) {"),
    trace: transition({ to: "blocked", reason: "core_unsupported" }),
  },
  n218: {
    mutation: distort("packages/contracts/src/schemas.ts", "owns_paths: z.array(z.string().min(1)).min(1),", "owns_paths: z.array(z.string().min(1)).min(0),"),
    trace: drill("sma_r01"),
  },
  n219: {
    mutation: wrongTarget("src/rooms/verification/sandbox.ts", '"--bind",input.workspacePath,input.workspacePath];', '"--ro-bind",input.workspacePath,input.workspacePath];'),
    trace: drill("sma_r01"),
  },
  n220: {
    mutation: flip("src/rooms/writer/server/start-admission.ts", "if(!state.writerThreadId&&storedTask.success&&storedTask.data.id===input.taskId) {", "if(state.writerThreadId&&storedTask.success&&storedTask.data.id===input.taskId) {"),
    trace: drill("sma_r01"),
  },
  n221: {
    mutation: flip("src/rooms/writer/server/sticky.ts", "return sameThread && sessionTurns(failed) >= cap ?", "return sameThread && sessionTurns(failed) > cap ?"),
    trace: rows("lane_pilot_attempt", "updated_at", "reason LIKE '%turn limit%'"),
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
