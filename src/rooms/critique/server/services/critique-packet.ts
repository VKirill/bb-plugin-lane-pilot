import { planPacket } from "@lane-pilot/workflow-engine";
import type { InputRef, PacketInput } from "@lane-pilot/workflow-engine";
import { sha256Hex } from "@lane-pilot/kit";
import {
  bbTaskFileIo, noteTaskFileRead, openRunHome, readTaskFile, recordRunFile, resolveTaskFile, taskHomeOf, taskPlanDbCopy, writeFileCreateOnly,
  type LanePilotDatabase,
} from "../../../storage";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The critic's input packet (audit: prompt → references). `planPacket` decides what fits inline and what stands as a
 * file; this helper is the I/O half the generic workflow does in workflow-executors: every spilled input lands under
 * `.agents/runs/<run>/inputs/` in the task's checkout — the same workspace the critic is spawned into — is delivered by
 * the shared create-only write (`writeFileCreateOnly`: absent → written, same bytes → reused, different bytes → throw),
 * read back and hash-checked, and recorded in the run manifest as `step-input`. There is no cut fallback: a write,
 * read-back, hash or manifest failure throws and the caller turns it into a named blocked result before any spawn.
 */

export type CriticPacket = { packet: string; refs: Record<string, InputRef> };

/**
 * The bounded prompt packet plus its materialized references. `chatId` stays empty so refs land in the run's own input
 * folder of the checkout, visible to a helper spawned on `hostId`/`checkoutPath`. Throws on any materialization
 * failure — callers must not spawn on a thrown packet.
 */
export async function prepareCriticPacket(bb: BbPluginApi, db: LanePilotDatabase, input: {
  runId: string; projectId: string; hostId: string; checkoutPath: string;
  step: { id: string; role: string; mode: string };
  goal?: string | undefined; goalInput?: string | undefined;
  inputs: readonly PacketInput[]; readers?: readonly string[]; workflowId?: string;
}): Promise<CriticPacket> {
  const plan = planPacket({
    step: input.step, ...(input.goal !== undefined ? { goal: input.goal } : {}), ...(input.goalInput ? { goalInput: input.goalInput } : {}),
    inputs: input.inputs, chatId: "", runId: input.runId, byReference: true,
  });
  if (!plan.files.length) return { packet: plan.packet, refs: plan.refs };
  const root = input.checkoutPath.replace(/\/+$/, "");
  const io = bbTaskFileIo(bb as unknown as Parameters<typeof bbTaskFileIo>[0], input.hostId, root);
  openRunHome(db, { runId: input.runId, projectId: input.projectId, workflowId: input.workflowId ?? "lp-task-pipeline", basePath: root, hostId: input.hostId });
  for (const file of plan.files) {
    await writeFileCreateOnly(bb.sdk.files as never, { hostId: input.hostId, rootPath: root, path: `${root}/${file.path}`, content: file.text });
    const back = await io.read(`${root}/${file.path}`);
    if (back === null || sha256Hex(back) !== sha256Hex(file.text)) throw new Error(`packet_ref_verify_failed:${file.path}`);
    await recordRunFile(db, io, {
      runId: input.runId, repoPath: file.path, kind: "step-input", nodeId: input.step.id, content: file.text,
      producer: { node: input.step.id, graph: input.workflowId ?? "lp-task-pipeline", stage_id: input.step.id, run_id: input.runId },
      readers: input.readers ?? [input.step.role],
    });
  }
  return { packet: plan.packet, refs: plan.refs };
}

/**
 * The canonical plan text for a critique stage, verified against the task manifest's recorded sha256 — `stagePlanText`
 * returns `read.text` without checking `drift`, which would let a PLAN.md edited after dispatch be judged as the
 * recorded revision. Drift is treated like an unreadable file: the database copy is accepted only when its hash is the
 * manifest row's, anything else throws a named error. A task with no home keeps its legacy plan text untouched.
 */
export async function readCanonicalPlan(bb: BbPluginApi, db: LanePilotDatabase, input: {
  taskId: string; reader: string; legacyPlan: string;
}): Promise<{ text: string; sha256: string | null }> {
  const home = taskHomeOf(db, input.taskId);
  if (!home) return { text: input.legacyPlan, sha256: null };
  const found = resolveTaskFile(db, input.taskId, "plan");
  if (!found) throw new Error(`task ${input.taskId}: its manifest lists no PLAN.md (kind plan); the stage stops instead of guessing a plan`);
  const io = bbTaskFileIo(bb as unknown as Parameters<typeof bbTaskFileIo>[0], home.host_id, home.base_path);
  const read = await readTaskFile(db, io, { taskId: input.taskId, kind: "plan", reader: input.reader });
  if (read && !read.drift) return { text: read.text, sha256: read.recordedSha256 ?? read.sha256 };
  const copy = taskPlanDbCopy(db, input.taskId, found.sha256);
  if (copy !== null) {
    noteTaskFileRead(db, { taskId: input.taskId, path: found.path, kind: "plan", reader: `${input.reader}:db-copy`, sha256: found.sha256, legacy: false });
    return { text: copy, sha256: found.sha256 };
  }
  throw new Error(read ? `plan_hash_mismatch:${input.taskId}` : `plan_unreadable:${input.taskId}`);
}
