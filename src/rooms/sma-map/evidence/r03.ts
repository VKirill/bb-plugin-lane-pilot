// Region 3 · Worker — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { drill, type RegionEvidence, voidIsHave, wfStep, wrongTarget } from "./types";

export default {
  // The worktree gets its own task's manifest-listed files and nothing else (docs/task-folder.md, T6).
  n397: { mutation: wrongTarget("src/rooms/storage/task-manifest.ts", "await to.write(`${root}/${repoPath}`, text);", "await to.write(`${root}/.agents/plans/items/${input.taskId}/${row.path}`, text);"), trace: drill("task_home") },
  n399: { voidReview: voidIsHave("строгий работник получает права (ACL) только на папку своей попытки и temp задачи, git доверяет только этому checkout; дерево работника — своя worktree lane/<попытка>, не рабочая копия человека") },
  // A helper may write only its own chat folders: LANE_PILOT_CHATS carries the thread's own id and its PM chat's (audit d8).
  n405: { mutation: wrongTarget("src/rooms/native-agent/server/helper-bb-shim.ts", 'stringAt(metadata, "parentPmThreadId")', 'stringAt(metadata, "pmThreadId")'), trace: drill("task_home") },
  n407: { trace: wfStep("lp.plan", "plan_critic") },
} satisfies RegionEvidence;
