// Region 4 · Daemon tick — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The card's «daemon pass» is, here, the plugin's own schedules (the phase driver's two-minute pass, the five-minute
// reconcile, the silence sweep, the daily copy sweep) plus the writer start's admission: none of them writes a row of its own
// for most nodes, so the nodes without a hub row take their trace from the region scene scripts/lp_drill/scenes/sma_r04.py,
// which boots the plugin on a fake host and fires the registered schedule (tick) — not the function under test.
import { distort, drill, flip, skipWrite, type RegionEvidence, voidIsHave } from "./types";

const STEPS = "src/rooms/phase/server/driver-steps.ts";
const CONTROL = "src/rooms/phase/server/driver-methods-control.ts";

export default {
  n415: { mutation: flip("src/rooms/platform/server/schedules.ts", '}, { isolated: true, timeoutMs: options.timeoutMs, overlap: "skip" });', '}, { isolated: false, timeoutMs: options.timeoutMs, overlap: "skip" });'), trace: drill("sma_r04") },
  n416: { mutation: distort("src/rooms/runs/conveyor.ts", "{ on: false, since: new Date(stored.at).toISOString()", "{ on: true, since: new Date(stored.at).toISOString()"), trace: drill("sma_r04") },
  n417: { mutation: distort("src/rooms/writer/server/state.ts", "if (total > 0) budget.noteTokens(threadId, total);", "if (total > 0) budget.noteTokens(threadId, total - 1);"), trace: drill("sma_r04") },
  n418: { mutation: distort("src/rooms/writer/server/writer-silence.ts", "{ count, at:now, ended:true } as never", "{ count, at:now, ended:false } as never"), trace: drill("sma_r04") },
  n419: { voidReview: voidIsHave("после перезапуска попытки сверяет reconcile: running/spawn_* попытка без треда сверяется с BB (shouldReconcileAttemptThread → reconcileAttemptThread), очередь и журнал — одна SQLite, расхождения нет"),
    mutation: flip("src/rooms/stability/server/reconcile.ts", 'if (attempt.state !== "cancel_requested") transitionAttempt(db, attempt.id, "running", { threadId:result.threadId });', 'if (attempt.state === "cancel_requested") transitionAttempt(db, attempt.id, "running", { threadId:result.threadId });'), trace: drill("sma_r04") },
  n420: { mutation: flip("src/rooms/storage/attempts-store/project-reads.ts", "WHERE a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.task_id=a.task_id)\n      AND a.state NOT IN ('accepted','canceled','queued','spawn_requested','spawn_unknown','running','cancel_requested')\n      AND a.updated_at>=?", "WHERE a.attempt_no=(SELECT MIN(b.attempt_no) FROM lane_pilot_attempt b WHERE b.task_id=a.task_id)\n      AND a.state NOT IN ('accepted','canceled','queued','spawn_requested','spawn_unknown','running','cancel_requested')\n      AND a.updated_at>=?"), trace: drill("sma_r04") },
  n421: { mutation: flip("src/rooms/stability/server/worktree-daily-pass.ts", 'const keptUnmerged = deep.kept.filter((row) => row.reason === "unmerged").length;', 'const keptUnmerged = deep.kept.filter((row) => row.reason !== "unmerged").length;'), trace: drill("sma_r04") },
  n422: { mutation: flip("src/rooms/backlog/server/scanner.ts", "projectToday >= PER_PROJECT_PER_DAY ||", "projectToday > PER_PROJECT_PER_DAY ||"), trace: drill("sma_r04") },
  n423: { mutation: flip(STEPS, "now() - lastAging > 86_400_000", "now() - lastAging < 86_400_000"), trace: drill("sma_r04") },
  n424: { mutation: distort("src/rooms/contracts/failure-class.ts", 'new Set(["harness", "infra", "dirty_base"])', 'new Set(["harness", "dirty_base"])'), trace: drill("sma_r04") },
  n425: { mutation: distort(STEPS, 'reactions.postOwnerItem({ key: phaseWordItemKey(phase.id, wordTurn[1]!, wordTurn[2]), source: "phase", kind: "word"', 'reactions.postOwnerItem({ key: phaseWordItemKey(phase.id, wordTurn[1]!, wordTurn[2]), source: "phase", kind: "wait"'), trace: drill("sma_r04") },
  n426: { mutation: flip("src/rooms/phase/logic/next-action.ts", "if (blocked.length) return { key: key(`blocked:", "if (!blocked.length) return { key: key(`blocked:"), trace: drill("sma_r04") },
  n427: { mutation: flip("src/rooms/tasks/rails.ts", "if (input.appetite !== null && input.appetite > free)", "if (input.appetite !== null && input.appetite < free)"), trace: drill("sma_r04") },
  n428: { mutation: flip("src/rooms/phase/server/auto-stages.ts", 'if (phase.stage === "design" && !r.design?.drawing && !tried("draw")', 'if (phase.stage === "design" && !!r.design?.drawing && !tried("draw")'), trace: drill("sma_r04") },
  n429: { mutation: flip(STEPS, '${lines.map((line) => `${line.ok ? "✓" : "✗"} ${line.id}`)', '${lines.map((line) => `${line.ok ? "✗" : "✓"} ${line.id}`)'), trace: drill("sma_r04") },
  n430: { mutation: distort(CONTROL, 'savePhase(db, phase.id, { state: "paused", at: now() });\n    return { phase: mustGet(phase.id), canceled };', 'savePhase(db, phase.id, { state: "stopped", at: now() });\n    return { phase: mustGet(phase.id), canceled };'), trace: drill("sma_r04") },
  n431: { mutation: flip(CONTROL, 'issued.has(taskFamily(row.task_id)) && row.state === "running" && row.thread_id)) {', 'issued.has(taskFamily(row.task_id)) && row.state === "queued" && row.thread_id)) {'), trace: drill("sma_r04") },
  n432: { mutation: flip("src/rooms/writer/server/writer-hold.ts", "else if (!free) free = { member, index };", "else if (free) free = { member, index };"), trace: drill("sma_r04") },
  n433: { mutation: distort(STEPS, "for (const item of next.slice(0, seats)) {", "for (const item of next.slice(0, seats + 1)) {"), trace: drill("sma_r04") },
  n434: { mutation: flip(STEPS, "phase.record.issueCap ?? 8) - atWork);", "phase.record.issueCap ?? 8) + atWork);"), trace: drill("sma_r04") },
  n435: { mutation: flip("src/rooms/tasks/run-policy.ts", "if(count<limit)this.active.set(runId,count+1);", "if(count<=limit)this.active.set(runId,count+1);"), trace: drill("sma_r04") },
  n436: { voidReview: voidIsHave("выдача = захват плюс удержания одним шагом: после ожидания места заново проверяются hold, пауза, конвейер, breaker; держимая задача не стартует"),
    mutation: flip("src/rooms/writer/server/start-admission.ts", "if ((lateHold !== null && lateHold > Date.now()) || lateBreaker || latePaused) {", "if ((lateHold !== null && lateHold < Date.now()) || lateBreaker || latePaused) {"), trace: drill("sma_r04") },
  n437: { mutation: flip("src/rooms/phase/server/driver.ts", ': !live.length ? "no live phase"', ': live.length ? "no live phase"'), trace: drill("sma_r04") },
  n438: { voidReview: voidIsHave("попытку без процесса держит состояние spawn_requested (любой возраст держит worktree), зависший старт через 15 мин завершается writer_start_stalled"),
    mutation: flip("src/rooms/writer/server/spawn-watchdog.ts", 'if (state === "spawn_requested" && !stalled) return;', 'if (state === "spawn_requested" && stalled) return;'), trace: drill("sma_r04") },
  n439: { mutation: skipWrite("src/rooms/writer/server/start-writer-task.ts", "state.releaseWriterSlot?.();"), trace: drill("sma_r04") },
} satisfies RegionEvidence;
