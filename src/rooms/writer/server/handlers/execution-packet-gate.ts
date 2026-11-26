import type { NodeExecutor, StepContext } from "../../../workflow";
import type { DispatchRuntime } from "../services/dispatch-workflow-ops";
import { hostContract } from "../../../contracts";
import { stringAt } from "@lane-pilot/kit";
import { setRunState, transitionAttempt } from "../../../storage";
import { buildExecutionPacket, packetSelectedLines } from "../../../tasks";
import { readFirstIo, repoReadRoot } from "../../../tasks/server";
import { recordStage } from "../../../runs/server";

/**
 * The `lp.execution-packet` gate and its block branch of `lp-task-pipeline`, registered by
 * `registerDispatchExecutors` (dispatch-workflow.ts). The packet is deterministic: a malformed read_first hint, a bad
 * line window, a source that changed mid-read or an unsupported host bound fails here, before the paid critic and
 * writer spend anything on a task that can never spawn (live: 8 CSVs of 10–158 MB in read_first burned every plan
 * critic first). Explicit windows read bounded slices for sources up to the host limit; larger or windowless-big
 * sources become deferred on-site reads, and missing sources stay advisory (`missing:true`). The writer spawn
 * rebuilds the same packet — this gate only moves the failure earlier, it decides nothing the spawn's own
 * execution_packet_failed guard does not already decide.
 */
export function registerExecutionPacketGate(
  exec: (key: string, run: (r: DispatchRuntime, ctx: StepContext<DispatchRuntime>) => Promise<Record<string, unknown>>, extra?: Partial<NodeExecutor<DispatchRuntime>>) => void,
  ended: (r: DispatchRuntime) => Record<string, unknown> | null,
  blocked: (r: DispatchRuntime, reason: string | undefined) => Record<string, unknown>,
): void {
  exec("lp.execution-packet", async (r) => {
    try {
      const host=r.ctx.bb.hosts.experimental_client({ contract: hostContract });
      const repoRootPath=(await repoReadRoot(host,r.runConfig.hostId,r.task.project_cwd,r.task.read_first??[]))?.root;
      const packet = await buildExecutionPacket(r.task.read_first ?? [], readFirstIo(
        { files: r.ctx.bb.sdk.files, host },
        { hostId: r.runConfig.hostId, rootPath: r.task.project_cwd, repoRootPath },
      ));
      // The outcome rides the edge into pm-read: the scout reuses the sha and line count instead of reading every source twice.
      return { ok: true, packetSha256: packet.sha256, selectedLines: packetSelectedLines(packet) };
    } catch (cause) {
      const reason = `execution_packet_failed:${cause instanceof Error ? cause.message : String(cause)}`;
      recordStage(r.ctx.db, { runId: r.runId, taskId: r.taskId, stageId: "execution-packet", state: "blocked", input: r.plan,
        result: { decision: "execution_packet_failed" }, reason });
      return { ok: false, reason };
    }
  }, { reentrant: true });

  exec("lp.block-execution-packet", async (r, ctx) => {
    const endedReply = ended(r);
    if (endedReply) return { reply: endedReply };
    const reason = stringAt(ctx.input.with, "reason") ?? "execution_packet_failed";
    transitionAttempt(r.ctx.db, r.attemptId, "blocked", { reason });
    setRunState(r.ctx.db, r.runId, "blocked");
    return { reply: blocked(r, reason) };
  });
}
