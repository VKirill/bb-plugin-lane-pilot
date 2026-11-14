// Region 1 · Task graph, batch e (n288-n319): the landing word, the task's birth and its gates, the row's states.
// Kept in its own file so evidence/r01.ts stays under the 500-line limit; r01.ts spreads it in.
import { distort, drill, entry, flip, type RegionEvidence, skipWrite, transition, voidIsHave, wrongTarget } from "./types";

export default {
  n288: {
    mutation: flip("src/rooms/phase/logic/acceptance.ts", '(word?.decision === "yes" && word[pick] === true)', '(word?.decision === "yes" && word[pick] !== true)'),
    trace: drill("sma_r01"),
  },
  n289: {
    mutation: flip("src/rooms/phase/logic/acceptance.ts", 'line("composition_verified", verdict?.state === "passed",', 'line("composition_verified", verdict?.state !== "passed",'),
    trace: drill("sma_r01"),
  },
  n290: {
    mutation: distort("src/rooms/verification/git-integrate/merge.ts", "reason:error.message,holder:error.holder}", 'reason:error.message,holder:"unknown"}'),
    trace: drill("sma_r01"),
  },
  n291: {
    mutation: flip("src/rooms/verification/git-integrate/merge.ts", "if(now!==input.expectedHead) return fail(", "if(now===input.expectedHead) return fail("),
    trace: drill("sma_r01"),
  },
  n292: {
    mutation: flip("src/rooms/phase/logic/acceptance.ts", "phase.record.bookWritten.seq === now.book.lastSeq && now.book.readSha", "phase.record.bookWritten.seq !== now.book.lastSeq && now.book.readSha"),
    trace: drill("sma_r01"),
  },
  n293: {
    mutation: flip("src/rooms/phase/logic/gates.ts", 'if (!checks.length && task.verify !== "none")', 'if (!checks.length && task.verify === "none")'),
    trace: drill("sma_r01"),
  },
  // The accepted attempt's receipts are written once into the task home in the base, so they outlive the worktree's removal (T13).
  n294: { mutation: wrongTarget("src/rooms/writer/server/task-home.ts", 'kind: "acceptance", name: "acceptance.json",', 'kind: "acceptance", name: `attempts/${input.attemptId}/acceptance.json`,'), trace: drill("task_home") },
  n295: {
    mutation: flip("src/rooms/workflow/server/after-accept.ts", 'if (event.scope !== "task" || event.status !== "accepted") return;', 'if (event.scope !== "task" || event.status === "accepted") return;'),
    trace: drill("sma_r01"),
  },
  n296: {
    mutation: flip("src/rooms/verification/server/merge-intent.ts", "if (!verdict.landed) { await clearMergeIntent(kv, intent.attemptId); continue; }", "if (verdict.landed) { await clearMergeIntent(kv, intent.attemptId); continue; }"),
    reach: entry("the plugin restarts after a merge landed on the project's machine and before the attempt's state caught up; the periodic pass reads the merge intent"),
    trace: drill("sma_r01"),
  },
  n297: {
    mutation: flip("src/rooms/tasks/words.ts", "if (attemptId && latest.attemptId && latest.attemptId !== attemptId)", "if (attemptId && latest.attemptId && latest.attemptId === attemptId)"),
    trace: drill("sma_r01"),
  },
  n298: {
    mutation: flip("src/rooms/phase/logic/acceptance.ts", "latest && latest.key === acceptanceKey(phase.record) ? latest : undefined", "latest && latest.key !== acceptanceKey(phase.record) ? latest : undefined"),
    reach: entry("the owner's word on an acceptance package arrives after the plan or the tree it judged has changed"),
    trace: drill("sma_r01"),
  },
  n299: {
    mutation: flip("src/rooms/contracts/task-enums.ts", 'phase: { promise: "require", topicLoop: false, drawing: false },', 'phase: { promise: "warn", topicLoop: false, drawing: false },'),
    trace: drill("sma_r01"),
  },
  n300: {
    mutation: distort("src/rooms/tasks/server/contract-lint.ts", '{ runId, state:"validation_failed", ...data,', '{ runId, state:"rejected", ...data,'),
    reach: entry("a PM or the owner enqueues a task contract"),
    trace: drill("sma_r01"),
  },
  n301: {
    mutation: skipWrite("src/rooms/storage/tasks-store.ts", "if (result.changes > 0) recordContractEdition(db, taskId, contract, getTaskPlan(db, taskId), reason);", "if (result.changes < 0) recordContractEdition(db, taskId, contract, getTaskPlan(db, taskId), reason);"),
    trace: drill("sma_r01"),
  },
  n302: {
    mutation: flip("src/rooms/tasks/rails.ts", "if (promise && !promiseOk) errors.push", "if (promise && promiseOk) errors.push"),
    reach: entry("a PM or the owner enqueues a task whose contract carries a promise"),
    trace: drill("sma_r01"),
  },
  n303: {
    mutation: flip("src/rooms/tasks/rails.ts", 'if (questions.length) errors.push({ code: "clarify_open"', 'if (!questions.length) errors.push({ code: "clarify_open"'),
    trace: drill("sma_r01"),
  },
  n304: {
    mutation: flip("src/rooms/tasks/rails.ts", '.filter((answer) => answer.by !== "owner");', '.filter((answer) => answer.by === "owner");'),
    trace: drill("sma_r01"),
  },
  n305: {
    mutation: flip("src/rooms/tasks/rails.ts", "task.clarify?.questions?.filter((question) => question.trim()) ?? [];", "task.clarify?.questions?.filter((question) => !question.trim()) ?? [];"),
    trace: drill("sma_r01"),
  },
  n306: {
    mutation: distort("src/rooms/tasks/rails.ts", "held)/.test(code)) return \"dependency\";", "held)/.test(code)) return \"conflict\";"),
    trace: transition({ to: "blocked", reason: "depends_on" }),
  },
  n307: {
    mutation: flip("src/rooms/tasks/server/contract-lint.ts", "input.programs?.get(program) === false) {", "input.programs?.get(program) === true) {"),
    trace: drill("sma_r01"),
  },
  n308: {
    mutation: flip("src/rooms/tasks/rails.ts", '&& !(task.drawing?.length)) warnings.push({ code: "drawing_needed"', '&& (task.drawing?.length)) warnings.push({ code: "drawing_needed"'),
    reach: entry("a PM or the owner enqueues a standalone task whose owned files are screens"),
    trace: drill("sma_r01"),
  },
  n309: {
    mutation: flip("src/rooms/phase/logic/design.ts", 'return ui.length ? { decision: "needed",', 'return !ui.length ? { decision: "needed",'),
    trace: drill("sma_r01"),
  },
  n310: {
    mutation: flip("src/rooms/phase/logic/design.ts", "signed !== undefined && signed !== drawing?.sha256", "signed !== undefined && signed === drawing?.sha256"),
    trace: drill("sma_r01"),
  },
  n311: {
    mutation: flip("src/rooms/phase/logic/design.ts", 'if (design.decision === "not_needed") return { ok: true };', 'if (design.decision !== "not_needed") return { ok: true };'),
    trace: drill("sma_r01"),
  },
  n312: {
    mutation: flip("src/rooms/writer/server/update-task.ts", "if (attempt && FINISHED_ATTEMPT_STATES.includes(attempt.state)) {", "if (attempt && !FINISHED_ATTEMPT_STATES.includes(attempt.state)) {"),
    trace: drill("sma_r01"),
  },
  n313: {
    mutation: flip("src/rooms/writer/server/update-task.ts", "if (!rerun.ok) {", "if (rerun.ok) {"),
    trace: drill("sma_r01"),
  },
  n314: {
    mutation: distort("src/rooms/tasks/server/queue-tool.ts", "Date.parse(input.until) : HOLD_FOREVER;", "Date.parse(input.until) : Date.now();"),
    trace: drill("sma_r01"),
  },
  n315: {
    mutation: distort("src/rooms/contracts/state-machine.ts", '{ from:null, event:"form_task", to:"queued" },', '{ from:null, event:"form_task", to:"spawn_requested" },'),
    trace: drill("sma_r01"),
  },
  n316: {
    mutation: flip("src/rooms/runs/server/task-board.ts", "held: (taskHeldUntil(db, row.task_id) ?? 0) > now, gates: null, wave: null,", "held: (taskHeldUntil(db, row.task_id) ?? 0) <= now, gates: null, wave: null,"),
    reach: entry("the PM holds a queued task with lane_pilot_queue hold, or the owner holds it from the cockpit"),
    trace: drill("sma_r01"),
  },
  n317: { mutation: flip("src/rooms/runs/server/task-reconcile.ts", ".filter((row) => !services.activeWriterTasks.has(", ".filter((row) => services.activeWriterTasks.has("), trace: drill("sma_r01"), voidReview:voidIsHave("состояние «заявлена» = попытка spawn_requested/running с живым циклом в activeWriterTasks; без живого цикла её забирает периодический проход (аренда = живой цикл)") },
  n318: {
    mutation: distort("src/rooms/tasks/words.ts", "the task is verified and waits for the owner's word to land on main", "the task is verified and needs no word to land on main"),
    trace: drill("sma_r01"),
  },
  n319: {
    mutation: distort("src/rooms/contracts/state-machine.ts", '{ from:"running", event:"checks_passed", to:"accepted" },', '{ from:"running", event:"checks_passed", to:"canceled" },'),
    trace: drill("sma_r01"),
  },
} satisfies RegionEvidence;
