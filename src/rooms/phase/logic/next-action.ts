import { planningText } from "../../contracts";
import { ANIMATOR_LAW, PLAN_ROUNDS_MAX, ambiguityScore, buildsScreens, rubricLine, stageInit } from "../stages";
import { acceptanceKey } from "./acceptance";
import { designGate, phaseFolder } from "./design";
import { discussionGate, planGate } from "./gates";
import { RISK_KINDS, type Phase, type PhaseStage, type WordTurn } from "./record";
import { wordOf } from "./words";
import { wordAsked, wordReason } from "./words-policy";
import type { TaskFact } from "./waves";

// ---------------------------------------------------------------- the driver's next action

export type NextAction = { key: string; stage: PhaseStage; text: string; waitsForPm: boolean };

const tool = (action: string, args = "") => `lane_pilot_phase {action:"${action}"${args}}`;

/**
 * What the phase needs now, in one instruction for the PM (the driver sends it once per key: «one wait — one message»). `waitsForPm` is
 * false when the driver itself has the next step (issuing a wave, waiting for writers, running the checks).
 */
export function nextAction(phase: Phase, facts: ReadonlyMap<string, TaskFact>, planningHome?: string | null): NextAction {
  const action = nextActionRaw(phase, facts);
  // With a planning home the files this text names are there: the PM gets their absolute folder (unset: the text as it always was).
  return planningHome ? { ...action, text: planningText(action.text, planningHome) } : action;
}

function nextActionRaw(phase: Phase, facts: ReadonlyMap<string, TaskFact>): NextAction {
  const id = phase.id;
  const r = phase.record;
  const head = `Phase ${id} «${phase.title}»`;
  const key = (suffix: string) => `${phase.stage}:${suffix}`;
  const questions = (r.questions ?? []).filter((question) => !question.answer && question.stage === phase.stage);
  if (questions.length) return { key: key(`questions:${questions.map((question) => question.id).join(",")}`), stage: phase.stage, waitsForPm: true,
    text: `${head} — open question(s) at ${phase.stage}: ${questions.map((question) => `${question.id}${question.blocking ? " (blocking)" : ""}: ${question.text}`).join("; ")}. Answer with ${tool("answer", `, phaseId:"${id}", questionId, answer`)}; ask the owner first (lane_pilot_ask_owner) if only he knows.` };
  const turn: WordTurn | null = phase.stage === "discussion" && wordAsked(r, "context") && r.context && discussionGate(r).ok && wordOf(r, "context")?.decision !== "yes" ? "context"
    : phase.stage === "planning" && wordAsked(r, "planning") && r.plan?.critique?.decision === "approve" && wordOf(r, "planning")?.decision !== "yes" ? "planning"
    : phase.stage === "design" && wordAsked(r, "design") && r.design?.drawing?.reviewer && wordOf(r, "design")?.decision !== "yes" ? "design"
    : phase.stage === "acceptance" && wordAsked(r, "uat") && r.uat && wordOf(r, "uat")?.decision !== "yes" ? "uat"
    : phase.stage === "acceptance" && wordAsked(r, "acceptance") && (r.acceptance?.lines ?? []).filter((line) => !line.ok).every((line) => line.id === "result_useful" || line.id === "limits_acknowledged")
      && (wordOf(r, "acceptance")?.decision !== "yes" || wordOf(r, "acceptance")?.key !== acceptanceKey(r)) ? "acceptance" : null;
  if (turn === "acceptance") return { key: key(`word:acceptance:${acceptanceKey(r)}`), stage: phase.stage, waitsForPm: true,
    text: `${head} is prepared and awaits the owner's keyed decision on package ${acceptanceKey(r)} (${wordReason(r, "acceptance")}): two decisions — is the result clear and useful, and are the remaining limits and the recovery acknowledged. He decides in the phase card, or ask him with lane_pilot_ask_owner and record it with ${tool("word", `, phaseId:"${id}", turn:"acceptance", decision:"yes"|"no", useful:true|false, limits:true|false, text`)}.` };
  // The key names what the word is for: a context signed again (or a plan submitted again) after a word is a new step for the PM. With
  // one key per turn the PM was never told (magicseo replay 2026-10-31: re-signed at 08:08, both sides waited on each other).
  const version = turn === "context" ? r.context?.sha : turn === "planning" ? r.plan?.sha : undefined;
  if (turn) return { key: key(`word:${turn}${version ? `:v${version.slice(0, 12)}` : ""}`), stage: phase.stage, waitsForPm: true,
    text: `${head} awaits the owner's word at ${turn} (${wordReason(r, turn)}). He gives it in the phase card, or ask him with lane_pilot_ask_owner and record it with ${tool("word", `, phaseId:"${id}", turn:"${turn}", decision:"yes"|"no", text${turn === "planning" && r.plan ? `, key:"${r.plan.sha}"` : ""}`)}.` };
  if (phase.state === "paused" || phase.state === "pause_requested") return { key: key("paused"), stage: phase.stage, text: `${head} is paused; ${tool("resume", `, phaseId:"${id}"`)} moves it on.`, waitsForPm: false };
  switch (phase.stage) {
    case "discussion": {
      const check = discussionGate(r);
      return { key: key(r.context?.sha ?? "none"), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 1, discussion. Goal: ${phase.goal}\nWrite the discussion to files in the project (problem, appetite, solution, rabbit holes, no-gos, decisions locked/free/deferred, FAQ, ADR — workflow lp.brainstorm or lp.analyze writes them), name the four risks (${RISK_KINDS.join(", ")}; a security risk beside them when there is one), then ${tool("context", `, phaseId:"${id}", docs:["<path>", ...], risks:{value, usability, feasibility, viability, security?}, appetite, noGos:[...]`)}: Lane Pilot reads and signs them${wordAsked(r, "context") ? ", and the owner signs the context with his word" : ""}; pass requirements:[ids] and decisions:[locked ids] when the phase has them — the plan must cover each.\nRead first: ${stageInit(phase).join(", ")}. ${rubricLine("discussion")}${check.ok ? "" : `\nOpen: ${check.why.join("; ")}`}` };
    }
    case "planning": {
      const check = planGate(r);
      return { key: key(`${r.plan?.sha ?? "none"}:${r.plan?.critique?.decision ?? "-"}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 2, planning, on context ${r.context?.sha.slice(0, 12) ?? "?"}${r.ambiguityGate === true ? ` (ambiguity ${ambiguityScore(r)})` : ""}.\n${r.plan && !r.plan.critique ? `The plan is submitted; Lane Pilot runs the independent plan checker itself (workflow lp.plan with plan_sha:"${r.plan.sha.slice(0, 12)}…") and reports the verdict — you do not start it, wait for the result.` : `Submit the plan with ${tool("plan", `, phaseId:"${id}", items:[{id, title, wave, promise:{given, when, then}, task:<task-v2>}]`)}; Lane Pilot then runs the independent plan checker itself (workflow lp.plan, whose plan critic is a session of its own, handed this plan's sha) and reports the verdict`} (round ${(r.plan?.rounds ?? 0) + 1} of ${PLAN_ROUNDS_MAX}).\nRead first: ${stageInit(phase).join(", ")}. ${rubricLine("planning")}${check.ok ? "" : `\nOpen: ${check.why.slice(0, 8).join("; ")}`}` };
    }
    case "design": {
      const check = designGate(r);
      return { key: key(`${r.design?.drawing?.sha256 ?? "none"}:${r.design?.drawing?.feasible ?? "-"}:${r.design?.drawing?.reviewer ?? "-"}`), stage: phase.stage, waitsForPm: true,
        // Lane Pilot draws the screens itself (auto stage lp.draw); a PM told to start design-lead too drew them a second time beside it
        // (magicseo replay 2026-10-31), and lane_pilot_specialist now refuses that designer while the phase has no drawing.
        text: !r.design?.drawing ? `${head} — stage 3, design (${r.design?.why ?? ""}). Lane Pilot draws the screens itself (lp.draw: design-lead draws into ${phaseFolder(id)}/design/ with UI-SPEC.md, another role checks); its drawing comes to this chat. Do not start a designer; a correction for the drawing goes to ${tool("correct", `, phaseId:"${id}", note`)}.${r.design?.motion?.length ? ` Motion rows ${r.design.motion.join(", ")}: ${ANIMATOR_LAW}.` : ""}`
          : `${head} — stage 3, design (${r.design?.why ?? ""}).\nTo change the drawing, have design-lead redraw the screens in ${phaseFolder(id)}/design/ (lane_pilot_helpers {action:"specialist", role:"design-lead", task}), then ${tool("drawing", `, phaseId:"${id}", paths:[...], designer, feasible:true|false, contradiction?, reviewer`)} — the reviewer is a role other than the designer (ui-review / design-taste). Mode: ${r.design?.mode ?? "screens"}; the drawing's paths include its UI-SPEC.md (lane-plan template fill UI-SPEC).${r.design?.motion?.length ? ` Motion rows ${r.design.motion.join(", ")}: ${ANIMATOR_LAW}.` : ""}\nRead first: ${stageInit(phase).join(", ")}. ${rubricLine("design")}${check.ok ? "" : `\nOpen: ${check.why.join("; ")}`}` };
    }
    case "execution": {
      const items = r.plan?.items ?? [];
      const issued = r.execution?.issued ?? {};
      const open = items.filter((item) => issued[item.id] && facts.get(item.id)?.state !== "accepted");
      const blocked = open.filter((item) => ["blocked", "canceled"].includes(facts.get(item.id)?.state ?? ""));
      // A broken piece leaves the stop by exactly one of skip, retry or cancel (SMA bi_decide); there is no fourth way out.
      if (blocked.length) return { key: key(`blocked:${blocked.map((item) => item.id).join(",")}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: ${blocked.map((item) => `${item.id} is ${facts.get(item.id)?.state}`).join("; ")}. Decide each: ${tool("decide", `, phaseId:"${id}", piece:"${blocked[0]!.id}", choice:"skip"|"retry"|"cancel", note`)} — skip drops it, retry issues it again, cancel stops the phase.` };
      const errors = Object.entries(r.execution?.issueErrors ?? {});
      if (errors.length) return { key: key(`issue_error:${errors.map(([piece]) => piece).join(",")}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: Lane Pilot could not issue ${errors.map(([piece, why]) => `${piece} (${why})`).join("; ")}. Decide each: ${tool("decide", `, phaseId:"${id}", piece:"${errors[0]![0]}", choice:"skip"|"retry"|"cancel", note`)} — skip drops it, retry issues the SAME contract again, cancel stops the phase. A contract that must change (a lint refusal) is not fixed by retry or by correct: ${tool("return", `, phaseId:"${id}", to:"planning", note`)} and submit the plan again.` };
      if (wordAsked(r, "issue") && !wordOf(r, "issue")) return { key: key("word:issue"), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution awaits the owner's word «issue» (${wordReason(r, "issue")}). Ask him, then ${tool("word", `, phaseId:"${id}", turn:"issue", decision:"yes"|"no", text`)}.` };
      // A wave that is in with a failing line stops the next wave: said to the PM, not left as «Lane Pilot issues the next wave».
      const red = Object.entries(r.execution?.waves ?? {}).find(([wave, done]) => !done.lines.every((line) => line.ok)
        && !items.some((item) => item.wave === Number(wave) && issued[item.id] && facts.get(item.id)?.state !== "accepted"));
      if (red) return { key: key(`wave_red:${red[0]}:${red[1].packageSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: wave ${red[0]} is in, but ${red[1].lines.filter((line) => !line.ok).map((line) => `${line.id} (${line.detail})`).join("; ")}; the pieces that depend on its pieces wait. A failing promise needs new work: return the phase to planning (${tool("return", `, phaseId:"${id}", to:"planning", note`)}) and change the failing piece (it is issued again) or add one.` };
      // A wave whose review by another model failed holds the phase at execution: said, with the review's words.
      const rejected = Object.entries(r.execution?.waves ?? {}).find(([, wave]) => wave.review?.state === "failed");
      if (rejected) return { key: key(`wave_review_failed:${rejected[0]}:${rejected[1].packageSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: the review of wave ${rejected[0]} by another model failed (${(rejected[1].review?.summary ?? "").slice(0, 600)}). Return the phase to planning (${tool("return", `, phaseId:"${id}", to:"planning", note`)}) and change the pieces it names (they are issued again), or add one.` };
      const unreviewed = Object.entries(r.execution?.waves ?? {}).find(([, wave]) => wave.lines.every((line) => line.ok) && r.waveReview && !wave.review);
      if (unreviewed) return { key: key(`wave_review:${unreviewed[0]}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — wave ${unreviewed[0]} is in (package ${unreviewed[1].packageSha.slice(0, 12)}). Have another model verify it (workflow lp.review on the wave's diff, a reviewer model other than the writers'), then ${tool("wave_review", `, phaseId:"${id}", wave:${unreviewed[0]}, state:"passed"|"failed", by, summary`)}; the phase leaves execution only after it.` };
      const unworded = Object.keys(r.execution?.waves ?? {}).find((wave) => wordAsked(r, "wave", Number(wave)) && !(r.words ?? []).some((word) => word.turn === "wave" && word.wave === Number(wave) && word.decision === "yes"));
      if (unworded) return { key: key(`word:wave:${unworded}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — wave ${unworded} awaits the owner's word (${wordReason(r, "wave", Number(unworded))}). Ask him, then ${tool("word", `, phaseId:"${id}", turn:"wave", wave:${unworded}, decision:"yes"|"no", text`)}.` };
      if (r.execution?.unchanged) return { key: key(`unchanged:${r.execution.unchanged.inputSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 4, execution: every piece is accepted, but nothing changed since the verification failed (${r.execution.unchanged.detail}). Return the phase to planning (${tool("return", `, phaseId:"${id}", to:"planning", note`)}) and change the failing piece's contract or add a piece; a changed piece is issued again.` };
      return { key: key(`running:${Object.keys(issued).length}:${open.length}`), stage: phase.stage, waitsForPm: false,
        text: `${head} — stage 4, execution: ${Object.keys(issued).length} of ${items.length} pieces issued, ${open.length} at work. Lane Pilot issues each further piece itself once the pieces it depends on are accepted.` };
    }
    case "verification": {
      const verdict = r.verification?.verdict;
      // The live interface check comes before the goal audit (SMA k_we_uiqa): the PM is not asked for the audit meanwhile.
      if (verdict?.state === "passed" && !r.verification?.live && r.liveCheck === true && (r.plan?.items ?? []).some(buildsScreens))
        return { key: key("live"), stage: phase.stage, waitsForPm: false,
          text: `${head} — stage 5, verification: Lane Pilot runs the live interface check (ui-audit) before the goal audit.` };
      if (verdict?.state === "failed") return { key: key(`verdict-failed:${verdict.inputSha}`), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 5, verification failed: ${verdict.detail}.${r.verification?.diagnosis?.inputSha === verdict.inputSha && r.verification.diagnosis.diagnosis ? ` Diagnosis: ${r.verification.diagnosis.diagnosis.slice(0, 600)}` : ""} Accepted pieces are not run again by themselves: return the phase to planning (${tool("return", `, phaseId:"${id}", to:"planning", note`)}) and change the failing piece's contract (a changed piece is issued again as a redo) or add a piece; a return to execution without new work meets the same verdict.` };
      if (verdict && !r.verification?.model) return { key: key("model"), stage: phase.stage, waitsForPm: true,
        text: `${head} — stage 5, verification: the blind check passed (${verdict.detail}). Run the goal audit (workflow lp.close) against the phase goal «${phase.goal}»${r.design?.drawing ? ` and the phase drawing (${r.design.drawing.paths.join(", ")})` : ""} and report it with ${tool("goal_audit", `, phaseId:"${id}", state:"met"|"unmet", by, summary`)}.` };
      return { key: key("running"), stage: phase.stage, waitsForPm: false, text: `${head} — stage 5, verification: Lane Pilot runs every piece's checks together on main.` };
    }
    case "acceptance": {
      const lines = r.acceptance?.lines ?? [];
      const bad = lines.filter((line) => !line.ok);
      return { key: key(bad.map((line) => line.id).join(",") || "ok"), stage: phase.stage, waitsForPm: bad.length > 0,
        text: bad.length ? `${head} — stage 6, acceptance holds: ${bad.map((line) => `${line.id}: ${line.detail}`).join("; ")}.` : `${head} — stage 6, accepted.` };
    }
    case "lessons":
      return { key: key(r.lessons?.analysis ? "written" : "analysis"), stage: phase.stage, waitsForPm: !r.lessons?.analysis,
        text: `${head} — stage 7, lessons (${r.lessons?.why ?? ""}). Run the retrospective (workflow retrospective) on the phase book and report it with ${tool("lessons", `, phaseId:"${id}", analysis, reviewRun`)}: reviewRun is that run; Lane Pilot reads from its journal that its «stage» step, a session other than the author's, was handed exactly this analysis.${wordAsked(r, "lesson") ? " The lesson then waits as a draft for the owner's word «lesson»." : ""}` };
    case "closed":
      return { key: key("closed"), stage: phase.stage, waitsForPm: false, text: `${head} is closed.` };
  }
}
