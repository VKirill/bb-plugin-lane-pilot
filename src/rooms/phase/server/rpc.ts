import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { PhaseApi } from "./driver";
import { phaseStageCells } from "../logic";

/** Phases over RPC: the list, one phase with its book, and the controls a person has on the screen. */
export function phaseRpc(api: PhaseApi) {
  return {
    phase_list: async ({ projectId, pmThreadId, live }) => api.list({ projectId, pmThreadId, live }).map((phase) => ({ ...phase, next: api.status(phase.id).next, cells: phaseStageCells(phase.stage, phase.state) })),
    phase_get: async ({ phaseId }) => { const id = api.resolve?.(null, phaseId)?.id ?? phaseId; const status = api.status(id); return { ...status, cells: phaseStageCells(status.phase.stage, status.phase.state), acceptancePackage: (await api.acceptancePackage?.(id)) ?? null }; },
    phase_files: async ({ phaseId, path }) => api.phaseFiles(phaseId, path),
    phase_act: async ({ action, projectId, pmThreadId, phaseId, payload }) => {
      const p = payload as Record<string, never>;
      const need = () => { if (!phaseId) throw new Error(`${action} names the phase`); return api.resolve?.(projectId, phaseId)?.id ?? phaseId; };
      const done = action === "open" ? await api.open({ projectId, pmThreadId, title: p.title, goal: p.goal, roadmapRow: p.roadmapRow })
        : action === "context" ? await api.context({ phaseId: need(), docs: p.docs, risks: p.risks, appetite: p.appetite, noGos: p.noGos, requirements: p.requirements, decisions: p.decisions, by: "screen" })
        : action === "plan" ? api.plan({ phaseId: need(), items: p.items, design: p.design })
        : action === "plan_check" ? await api.planCheck({ phaseId: need(), decision: p.decision, by: p.by, summary: p.summary, wfRunId: p.wfRunId })
        : action === "drawing" ? await api.drawing({ phaseId: need(), paths: p.paths, designer: p.designer, feasible: p.feasible, contradiction: p.contradiction, reviewer: p.reviewer, critique: p.critique, lesson: p.lesson })
        : action === "goal_audit" ? api.goalAudit({ phaseId: need(), state: p.state, by: p.by, summary: p.summary, points: p.points })
        // Context note: the owner's note goes to the writers of the pieces at work; an answer settles a stage question.
        : action === "correct" ? (await api.correct({ phaseId: need(), note: p.note, pieces: p.pieces, by: "owner" })).phase
        : action === "answer" ? api.answer({ phaseId: need(), questionId: p.questionId, answer: p.answer, by: "owner via screen" })
        : api.lessons({ phaseId: need(), analysis: p.analysis, reviewRun: p.reviewRun, reviewerNode: p.reviewerNode });
      return api.status(done.id);
    },
    phase_control: async ({ phaseId: ref, action, to, note, turn, decision, wave, useful, limits, key, piece, choice, line, result }) => {
      const phaseId = api.resolve?.(null, ref)?.id ?? ref;
      if (action === "word") {
        if (!turn || !decision) throw new Error("the owner's word names the turn and the decision");
        return api.status((await api.word({ phaseId, turn, decision, text: note?.trim() || decision, wave, useful, limits, key, by: "owner via screen" })).id);
      }
      if (action === "return") {
        if (!to || !note?.trim()) throw new Error("a return names the stage and carries a note");
        return api.status(api.returnTo({ phaseId, to, note, by: "owner" }).id);
      }
      if (action === "stop_wave") return { ...(await api.stopWave({ phaseId, by: "owner" })), status: api.status(phaseId) };
      if (action === "interrupt") return { ...(await api.interrupt({ phaseId, words: note, by: "owner" })), status: api.status(phaseId) };
      if (action === "decide") {
        if (!piece || !choice) throw new Error("a decision names the piece and one of skip, retry, cancel");
        return api.status((await api.decide({ phaseId, piece, choice, note, by: "owner" })).id);
      }
      // The owner's trim (SMA d_batch_decide): a piece not yet issued leaves the plan with his note; an issued one is refused.
      if (action === "withdraw") {
        if (!piece) throw new Error("a withdraw names the piece");
        if (!note?.trim()) throw new Error("a withdraw carries the owner's note: why the piece leaves the plan");
        return api.status(api.withdraw({ phaseId, pieces: [piece], note: note.trim(), by: "owner" }).id);
      }
      if (action === "uat_line") {
        if (!line || !result) throw new Error("a UAT answer names the line's number and pass or fail");
        return api.status((await api.uatLine({ phaseId, line, result, note, by: "owner via screen" })).id);
      }
      if (action === "stop") return api.status((await api.stop({ phaseId, words: note, by: "owner" })).phase.id);
      if (action === "close" && !note?.trim()) throw new Error("closing in words carries the words");
      return api.status(api.setState({ phaseId, state: action, words: note, by: "owner" }).id);
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "phase_list" | "phase_get" | "phase_files" | "phase_act" | "phase_control">;
}
