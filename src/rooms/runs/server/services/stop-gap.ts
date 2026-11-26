import { postOwnerItem } from "../../../owner-waiting";
import type { LanePilotDatabase } from "../../../storage";

/**
 * Matvey's two-condition stop gap: when a writer's process exit and the hand-back of its work do not both complete,
 * the stopped turn never continues and the gap goes to the owner inbox naming the task, writer, and attempt.
 */
export function reportStopGapOwnerItem(
  db: LanePilotDatabase,
  input: {
    projectId?: string | null;
    runId: string;
    taskId: string;
    attemptId: string;
    writerThreadId?: string | null;
    gap: "exit_without_handback" | "process_not_exited";
    detail?: string | null;
  },
  now = Date.now(),
): void {
  const who = input.writerThreadId ? `писатель ${input.writerThreadId} (задача ${input.taskId}, попытка ${input.attemptId})` : `задача ${input.taskId} (попытка ${input.attemptId})`;
  const what = input.gap === "exit_without_handback"
    ? `Остановка неполна: процесс писателя завершён без сдачи работы — ${who}`
    : `Остановка зависла: процесс писателя не подтвердил выход — ${who}`;
  const why = input.gap === "exit_without_handback"
    ? `Процесс писателя вышел, но снимок/передача worktree не подтверждены к дедлайну (${input.detail ?? "hand-back missing"}). Остановленный ход закрыт и больше не продолжится.`
    : `Повторная проверка после команды остановки не увидела выхода процесса (${input.detail ?? "exit timeout"}). Ход остановлен и больше не продолжится.`;
  postOwnerItem(db, {
    key: `stop-gap:${input.attemptId}`,
    source: "writer",
    kind: input.gap,
    reason: "blocked",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    what,
    why,
    evidence: [
      { kind: "run", ref: input.runId },
      { kind: "task", ref: input.taskId },
      { kind: "attempt", ref: input.attemptId },
      ...(input.writerThreadId ? [{ kind: "text" as const, ref: input.writerThreadId }] : []),
    ],
  }, now);
}
