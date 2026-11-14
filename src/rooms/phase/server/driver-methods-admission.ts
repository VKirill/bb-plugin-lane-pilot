import { switchOn, switchWord } from "@lane-pilot/models";
import { randomUUID } from "node:crypto";
import { latestRunForPmThread } from "../../storage";
import { sha256Hex, bestEffort } from "@lane-pilot/kit";
import { RISK_KINDS, anyTurnAsks, checkerIndependence, contextSignature, designDecision, discussionGate, isPlanWordGap, phaseFolder, planGate, planGate as planGateOf, planSignature, withComputedWaves, wordAsked, wordTurnsOf } from "../logic";
import { planText, specText } from "../stages";
import { insertPhase, listPhases, savePhase } from "../store";
import { PhaseRefusal } from "./driver-tools";
import type { MethodsTools } from "./driver-methods";
import type { ContextDoc, Phase, PhaseRecord, PlanItem, RiskKey } from "../logic";

type Reported = { phaseId: string; by?: string };
export type OpenInput = { projectId: string; pmThreadId: string; title: string; goal: string; legacy?: boolean; roadmapRow?: string; rails?: boolean };
export type ContextInput = Reported & { docs: string[]; risks?: Partial<Record<RiskKey, string>>; requirements?: string[]; decisions?: string[]; appetite?: string; noGos?: string[] };
export type PlanInput = Reported & { items: Array<Omit<PlanItem, "wave"> & { wave?: number }>; design?: boolean; alreadyMet?: string; fromRun?: string; objective?: string; premortem?: string[] };
export type PlanCheckInput = Reported & { decision: "approve" | "changes_requested"; by: string; summary?: string; wfRunId?: string };

/** Opening a phase and admitting its plan: open, the signed context, the plan and its check, and the gate that admits it. */
export function installAdmissionMethods(tools: MethodsTools) {
  const { ctx, services, db, now } = tools;
  const { mustGet, book, move, readFile, writeGenerated, freshTurns, freshTurnsSync } = tools;

  async function open(input: { projectId: string; pmThreadId: string; title: string; goal: string; legacy?: boolean; roadmapRow?: string; rails?: boolean }): Promise<Phase> {
    // A roadmap row is one address (SMA pc_folder): a live phase already on it is named, never shadowed by a second.
    if (input.roadmapRow) {
      const held = listPhases(db, { projectId: input.projectId, live: true }).find((phase) => phase.record.roadmapRow === input.roadmapRow);
      if (held) throw new PhaseRefusal(`roadmap row ${input.roadmapRow} already has a live phase: ${held.id} «${held.title}» — work with that one, or close it first`);
    }
    const id = `ph_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const runId = latestRunForPmThread(db, input.pmThreadId)?.id ?? null;
    insertPhase(db, { id, projectId: input.projectId, pmThreadId: input.pmThreadId, runId, title: input.title.slice(0, 200), goal: input.goal.slice(0, 4000), at: now() });
    const settings = await ctx.effectiveProjectSettings(input.projectId).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>));
    // Each turn decides its own word from its own evidence (logic/words-policy.ts); at opening only the context's is known: the title and goal.
    const wordTurns = wordTurnsOf({ title: input.title, goal: input.goal, record: {} }, settings, now());
    const ownerWords = anyTurnAsks({ wordTurns });
    const waveReview = String(settings["phase.wave_review"] ?? "on") !== "off";
    const capSetting = Number(settings["phase.issue_cap"] ?? 8);
    const issueCap = Number.isInteger(capSetting) && capSetting >= 1 && capSetting <= 50 ? capSetting : 8;
    const qaHost = String(settings["browser_qa.host_id"] ?? "").trim();
    let phase = mustGet(id);
    book(phase, "goal", "opened", `phase opened: ${input.title}${wordTurns.mode === "on" || wordTurns.mode === "risky" ? ` (the owner's word is asked at the turns: owner.words ${wordTurns.mode})` : wordTurns.mode === "sensitive" ? ` (owner.words sensitive: the owner's word is asked only at a turn in money, data or a production deploy${wordTurns.context?.asks ? `; the context is: ${wordTurns.context.classes.join(", ")}` : ""})` : ""}`);
    if (switchOn(settings, "browser_qa.enabled") && !qaHost)
      book(phase, "verification", "live_check", "live interface check not run: no browser machine named: bb lane-pilot setting browser_qa.host_id=<host>");
    const record: PhaseRecord = { ownerWords, wordTurns, waveReview, issueCap, scope: { revisions: 0, withdrawn: [] },
      autonomous: String(settings["phase.autonomous"] ?? "off") === "on", subagents: String(settings["phase.subagents"] ?? "on") !== "off",
      planBounce: switchOn(settings, "phase.plan_bounce"),
      // The switches below are copied once, here, and each is read from the record as `=== true` (an absent field is off): a phase opened
      // before them, and a project that sets nothing, run exactly as they always did. phase.commit_docs is read as `=== false`.
      ...(!switchOn(settings, "phase.commit_docs") ? { commitDocs: false } : {}),
      ...(switchOn(settings, "phase.threat_closure") ? { threatClosure: true } : {}),
      ...(switchOn(settings, "phase.design_points") ? { designPoints: true } : {}),
      ...(switchOn(settings, "phase.doc_files") ? { docFiles: true } : {}),
      ...(switchOn(settings, "phase.ambiguity_gate") ? { ambiguityGate: true } : {}),
      ...(switchOn(settings, "phase.piece_notes") ? { pieceNotes: true } : {}),
      // SMA k_we_verify/k_we_uiqa: the browser check is on unless switched off (browser_qa.enabled=off opts out); it owes
      // work only where a browser machine is named (browser_qa.host_id, project row else the hub-wide one). On with no
      // machine named, the live check is recorded as not run and the phase goes on — nothing that passes today may hold.
      liveCheck: switchOn(settings, "browser_qa.enabled") && !!qaHost,
      ...(switchOn(settings, "browser_qa.enabled") && !qaHost
        ? { verification: { live: { state: "skipped" as const, reason: "no browser machine named: bb lane-pilot setting browser_qa.host_id=<host>", at: now() } } }
        : {}),
      branch: switchWord(settings, "phase.branch") as "none" | "phase" | "milestone", ...(input.roadmapRow ? { roadmapRow: input.roadmapRow } : {}), ...(input.rails ? { rails: true } : {}),
      ...(switchOn(settings, "phase.research") ? { research: "on" as const } : {}),
      ...(switchOn(settings, "phase.pattern_map") ? { patternMap: "on" as const } : {}),
      ...(switchOn(settings, "phase.validation") ? { validation: "on" as const } : {}),
      ...(switchOn(settings, "phase.draw_material") ? { drawMaterial: "on" as const } : {}),
      ...(String(settings["phase.train"] ?? "on") === "off" ? { train: false } : {}),
      ...(switchOn(settings, "phase.diagnose") ? { diagnose: true } : {}),
      ...(switchOn(settings, "phase.gray_areas") ? { grayAreas: true } : {}),
      // phase.grill_gate is on unless switched off (SMA k_v_grill): absent means the hold stands.
      ...(String(settings["phase.grill_gate"] ?? "") === "off" ? { grillGate: false } : {}) };
    if (input.legacy) {
      // Legacy mode without signature: a plan written before the phase existed is admitted on its own; the book says so.
      record.context = { docs: [], sha: sha256Hex(`legacy:${id}`), signedAt: now(), legacy: true };
      move(phase, "planning", record, "legacy mode: the plan exists already, there is no signed discussion");
    } else savePhase(db, phase.id, { record, at: now() });
    phase = mustGet(id);
    return phase;
  }

  async function context(input: ContextInput): Promise<Phase> {
    const phase = await freshTurns(mustGet(input.phaseId));
    if (phase.stage !== "discussion") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}: return it to discussion first to change its context`);
    const docs: ContextDoc[] = [];
    for (const path of [...new Set(input.docs)].slice(0, 20)) {
      const file = await readFile(phase, path);
      docs.push({ path, sha256: file.sha256, bytes: file.sizeBytes });
    }
    const risks = Object.fromEntries([...RISK_KINDS, "security" as const].map((kind) => [kind, input.risks?.[kind]?.trim() ?? ""]).filter(([, text]) => text)) as Partial<Record<RiskKey, string>>;
    const noGos = (input.noGos ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 30);
    const record: PhaseRecord = { ...phase.record, context: { docs, sha: contextSignature(docs), signedAt: now(), risks,
      ...(input.appetite?.trim() ? { appetite: input.appetite.trim().slice(0, 600) } : {}), ...(noGos.length ? { noGos } : {}),
      ...(input.requirements?.length ? { requirements: [...new Set(input.requirements)] } : {}), ...(input.decisions?.length ? { decisions: [...new Set(input.decisions)] } : {}) } };
    // SMA pc_contract: a yes counts only for the version it was given on — a context signed again voids the earlier word.
    if (record.context!.sha !== phase.record.context?.sha && record.words) record.words = record.words.filter((word) => word.turn !== "context");
    // A new signature is a new base for the plan: failures spent planning against the old documents are forgotten, so a phase
    // whose context was re-signed plans again (PH1: the plan tries stayed spent after the owner re-signed CONTEXT.md).
    if (record.context!.sha !== phase.record.context?.sha) {
      const drop = (map?: Partial<Record<string, number>>) => { if (!map) return undefined; const { plan: _plan, ...rest } = map; return Object.keys(rest).length ? rest : undefined; };
      record.autoFailures = drop(record.autoFailures);
      record.autoFailuresTotal = drop(record.autoFailuresTotal);
      record.autoMachineFailures = drop(record.autoMachineFailures);
    }
    const check = discussionGate(record);
    if (!check.ok) { savePhase(db, phase.id, { record, at: now() }); throw new PhaseRefusal("the discussion is not complete", check.why); }
    book(phase, "discussion", "signed", `context signed ${record.context!.sha.slice(0, 12)}: ${docs.map((doc) => `${doc.path} (${doc.bytes} B)`).join(", ")}; appetite — ${record.context!.appetite ?? "—"}; no-gos — ${noGos.join("; ") || "—"}; risks — ${[...RISK_KINDS, "security" as const].filter((kind) => risks[kind]).map((kind) => `${kind}: ${risks[kind]}`).join("; ")}`);
    // Context signature (SMA p1_confirm): the author is a person. With owner.words on the machine's signature waits for his word «context».
    if (wordAsked(record, "context")) {
      savePhase(db, phase.id, { record, at: now() });
      book(phase, "discussion", "awaits_signature", "the context is complete and awaits the owner's signature (his word «context»)");
      return mustGet(phase.id);
    }
    move(phase, "planning", record, "the context documents exist, none is empty, and they are signed");
    // SMA k_pl_spec: with phase.doc_files on, SPEC.md lands with the signed context — what the phase delivers.
    if (record.docFiles === true) await bestEffort(ctx.log, "phase spec write", writeGenerated(mustGet(phase.id), `${phaseFolder(phase.id)}/SPEC.md`, specText(mustGet(phase.id)), `phase ${phase.id}: SPEC.md`), null);
    return mustGet(phase.id);
  }

  function plan(input: PlanInput): Phase {
    const phase = mustGet(input.phaseId);
    // No replanning of a closed phase: its book is final; a new goal is a new phase.
    if (phase.stage === "closed" || phase.state === "closed") throw new PhaseRefusal(`phase ${phase.id} is closed: open a new phase for new work`);
    if (phase.stage !== "planning") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}: a plan is submitted at planning (return the phase there first)`);
    if (!phase.record.context) throw new PhaseRefusal("the phase has no signed context");
    // The waves are laid out from the pieces' depends_on (SMA bf_waves): a piece submitted without one gets its computed wave; a
    // cycle leaves its pieces without a wave, and the plan gate refuses the plan (SMA p2_waves).
    const items: PlanItem[] = withComputedWaves(input.items.map((item) => ({ ...item, task: { ...item.task, id: item.id } })));
    const contextSha = phase.record.context.sha;
    // `alreadyMet`: the planner found the repository already doing what the goal asks, a plan with no pieces that the plan gate admits as such.
    const record: PhaseRecord = { ...phase.record, plan: { items, contextSha, sha: planSignature(items, contextSha), rounds: phase.record.plan?.rounds ?? 0, submittedAt: now(),
      ...(input.objective?.trim() ? { objective: input.objective.trim().slice(0, 600) } : {}),
      ...(input.premortem?.length ? { premortem: input.premortem.map((risk) => risk.trim()).filter(Boolean).slice(0, 10) } : {}),
      ...(input.fromRun ? { fromRun: input.fromRun } : {}), ...(input.alreadyMet ? { alreadyMet: { evidence: input.alreadyMet.slice(0, 1000) } } : {}) } };
    // SMA pc_contract: a resubmitted plan with another signature voids the owner's earlier planning yes.
    if (record.plan!.sha !== phase.record.plan?.sha && record.words) record.words = record.words.filter((word) => word.turn !== "planning");
    if (input.design) record.design = designDecision(items, true);
    savePhase(db, phase.id, { record, at: now() });
    if (input.alreadyMet) book(phase, "plan", "already_met", `the planner found the goal already met, no pieces to build: ${input.alreadyMet.slice(0, 1000)}`);
    else book(phase, "plan", "submitted", `plan ${record.plan!.sha.slice(0, 12)}: ${items.length} piece(s) in ${new Set(items.map((item) => item.wave)).size} wave(s) — ${items.map((item) => `${item.id} (w${item.wave}): ${item.promise.then}`).join("; ")}`);
    // The new plan is this turn's evidence: its pieces decide whether planning, issue and each wave ask for the owner's word.
    return freshTurnsSync(mustGet(phase.id));
  }

  async function planCheck(input: PlanCheckInput): Promise<Phase> {
    const phase = await freshTurns(mustGet(input.phaseId));
    if (phase.stage !== "planning" || !phase.record.plan) throw new PhaseRefusal("no plan at planning to check");
    // Context files unchanged: the documents the plan stands on are read again; an edit after the signature sends the phase back.
    for (const doc of phase.record.context?.docs ?? []) {
      const file = await readFile(phase, doc.path);
      if (file.sha256 !== doc.sha256) {
        book(phase, "discussion", "context_changed", `${doc.path} changed after the signature`);
        throw new PhaseRefusal(`${doc.path} changed after the context was signed: return the phase to discussion and sign it again`);
      }
    }
    const rounds = (phase.record.plan.rounds ?? 0) + (input.decision === "changes_requested" ? 1 : 0);
    const steps = input.wfRunId ? tools.journalSteps(input.wfRunId) : null;
    const bound = input.wfRunId ? tools.checkerRunBinding(phase, input.wfRunId, input.decision) : null;
    const independence = !input.wfRunId ? undefined : !steps ? { ok: false, wfRunId: input.wfRunId, why: `workflow run ${input.wfRunId} is not in the journal` }
      : bound ? { ok: false, wfRunId: input.wfRunId, why: bound }
      : checkerIndependence(input.wfRunId, steps, { pmThread: phase.pmThreadId, submittedAt: phase.record.plan.submittedAt });
    const record: PhaseRecord = { ...phase.record, plan: { ...phase.record.plan, rounds, critique: { decision: input.decision, by: input.by, ...(input.summary ? { summary: input.summary } : {}), ...(independence ? { independence } : {}) } } };
    book(phase, "plan", "checked", `${input.by}: ${input.decision}${input.summary ? ` — ${input.summary}` : ""}`);
    savePhase(db, phase.id, { record, at: now() });
    const check = planGate(record);
    if (!check.ok) {
      const waitsForWord = wordAsked(record, "planning") && check.why.length === 1 && isPlanWordGap(check.why[0]!);
      if (waitsForWord) return mustGet(phase.id);
      throw new PhaseRefusal("the plan is not admitted", check.why);
    }
    return admitIfReady(mustGet(phase.id));
  }
  /** Admits the plan when its gate holds (after the checker's approval, or after the owner's word when owner.words is on). */
  async function admitIfReady(phase: Phase): Promise<Phase> {
    const record: PhaseRecord = { ...phase.record };
    const check = planGateOf(record);
    if (!check.ok || !record.plan) return phase;
    // SMA k_v_grill: a plan grilled with open challenges waits — the owner's word on this plan, or a plan that answers
    // them, lifts it (phase.grill_gate=off switches the hold off). A plan never grilled passes as before.
    const grill = tools.grillBlock(phase);
    // owner.words=sensitive and a plan outside money, data and production deploys (default-path audit §5.4.3): the grill's open challenges
    // do not wait for the owner. The machine plans once more with them as the gaps (lp.plan in gaps mode); a plan still grilled open after
    // that is admitted with the challenges in the book.
    if (grill && record.wordTurns?.mode === "sensitive" && !wordAsked(record, "planning")) {
      if (!record.grillReplan) {
        book(phase, "plan", "grill_replan", `grill ${grill.runId} left open challenges: ${grill.open.join("; ")} — owner.words sensitive and the plan touches no money, data or production deploy: the machine plans once more with them as the gaps instead of waiting for the owner`);
        savePhase(db, phase.id, { record: { ...record, grillReplan: { planSha: record.plan.sha, at: now() }, replan: { gaps: `the grill of plan ${record.plan.sha.slice(0, 12)} left open challenges; answer each in the plan: ${grill.open.join("; ")}`, count: record.replan?.count ?? 0 } }, at: now() });
        return mustGet(phase.id);
      }
      book(phase, "plan", "grill_passed", `grill ${grill.runId} still has open challenges after the machine's replan: ${grill.open.join("; ")} — owner.words sensitive and the plan touches no money, data or production deploy: admitted over them, they stay here for the verifier and the lessons`);
    } else if (grill) {
      book(phase, "plan", "grill_blocked", `grill ${grill.runId} left open challenges: ${grill.open.join("; ")} — admission waits: the owner's word on this plan (a planning yes) lifts it, or a plan that answers them (phase.grill_gate=off switches the hold off)`);
      // The caller hears it too, not only the book: the reason and the two ways out.
      throw new PhaseRefusal(`the plan is not admitted: the grill ${grill.runId} of this plan ended open`, [
        ...grill.open.map((challenge) => `open grill question: ${challenge}`),
        "way out 1: answer the open grill questions, then resubmit the plan (lp.plan) so it is checked again",
        "way out 2: set phase.grill_gate=off for the project to admit over an open grill",
      ]);
    }
    // SMA k_v_grill: the pre-push plan is budget-aware — it states the appetite left in the run's token budget and the
    // money hold as they read at admission; no cap set reads «no monthly cap», it does not invent one.
    const snap = phase.runId ? services.runBudgets.get(phase.runId)?.snapshot() : undefined;
    const tokensLeft = snap?.limits.maxTokens !== undefined ? snap.limits.maxTokens - snap.tokens : null;
    const money = await bestEffort(ctx.log, "plan budget read", Promise.resolve().then(() => services.money?.status() ?? null), null);
    const budget = `run tokens left: ${tokensLeft === null ? "no cap" : tokensLeft}; money hold: ${!money || money.capSet !== true ? "no monthly cap" : money.left !== null && money.left <= 0 ? `cap $${money.cap} spent ($${money.monthUsd} this month)` : `cap $${money.cap}, $${money.left} left`}`;
    record.plan = { ...record.plan, admittedSha: record.plan.sha, admittedAt: now(), budget };
    record.design = record.design?.decision === "needed" ? record.design : designDecision(record.plan.items);
    book(phase, "plan", "admitted", `plan ${record.plan.sha.slice(0, 12)} admitted; drawing ${record.design.decision === "needed" ? "needed" : "not needed"}: ${record.design.why}; budget read: ${budget}`);
    move(phase, record.design.decision === "needed" ? "design" : "execution", record, "the plan is admitted");
    const admitted = mustGet(phase.id);
    // SMA k_wp_commit / k_t_template: with phase.doc_files on, the admitted plan is written (and committed) as PLAN.md.
    if (record.docFiles === true) await bestEffort(ctx.log, "phase plan write", writeGenerated(admitted, `${phaseFolder(phase.id)}/PLAN.md`, planText(admitted), `phase ${phase.id}: PLAN.md`), null);
    return mustGet(phase.id);
  }

  return { open, context, plan, planCheck, admitIfReady };
}
