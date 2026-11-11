import { upsertLessonProposal } from "@lane-pilot/run-insights";
import { experienceIsSupported, experiencePrompt, parseEdits, parseExperience } from "@lane-pilot/harness-core";
import { type ServerCore } from "../../contracts/server";
import type { ChainRuntime } from "../../contracts/server";
import { verdictForHarness } from "../../bench";
import { evidenceFiles, evidenceLayout, treeDiff, type LibraryEntry } from "./evidence";
import { getHarness, listHarnesses, saveExperience, setHarnessState, trialAttempts } from "./store";
import { decideTrial, type AdoptBy, type TrialDecision } from "./trial";
import { HARNESS_DIR, harnessMission, inferForm, slug } from "./parts";
import { type HarnessConfig } from "./config";
import { HARNESS_REFLECT_WORKFLOW, type HarnessStep, type Services } from "./contract";
import type { createSessions } from "./sessions";
import type { createEvidence } from "./evidence-collect";

type Deps = {
  config: (projectId: string) => Promise<HarnessConfig>;
  place: ReturnType<typeof createSessions>["place"];
  writeFiles: ReturnType<typeof createSessions>["writeFiles"];
  session: ReturnType<typeof createSessions>["session"];
  collectEvidence: ReturnType<typeof createEvidence>["collectEvidence"];
  libraryEntries: (projectId: string, area: string) => LibraryEntry[];
};

/** A decided trial's judgement (`evaluateTrials`) and the reflection run of `lp.harness-reflect` (prepare, reflect, record). */
export function createReflect(ctx: ServerCore, services: Services, deps: Deps) {
  const { db } = ctx;
  const { config, place, writeFiles, session, collectEvidence, libraryEntries } = deps;

  /** The newest bench comparison on a tree and the rule that decides who adopts (`adoptBy`). */
  function benchInput(cfg: HarnessConfig, harnessId: string): { adoptBy: AdoptBy; verdict: { passed: boolean; summary: string } | null } {
    const verdict = verdictForHarness(db, harnessId);
    const report = verdict?.report as { armA?: string; armB?: string; verdict?: string } | null | undefined;
    return { adoptBy: cfg.adoptBy, verdict: verdict ? { passed: verdict.passed, summary: `${report?.armB ?? verdict.armB} vs ${report?.armA ?? verdict.armA} on set ${verdict.setId.replace("benchset_", "")}` } : null };
  }

  /** The trials of a project judged on their attempts; a decided trial gets its reflection. */
  async function evaluateTrials(projectId: string, options: { dryRun?: boolean; now?: number } = {}): Promise<Array<{ id: string; area: string; writerKey: string; decision: TrialDecision }>> {
    const cfg = await config(projectId);
    const now = options.now ?? Date.now();
    const out: Array<{ id: string; area: string; writerKey: string; decision: TrialDecision }> = [];
    for (const trial of listHarnesses(db, projectId, { states: ["trial"] })) {
      const rows = trialAttempts(db, trial);
      const decision = decideTrial(rows, trial.trialStartedAt ?? trial.createdAt, now, cfg.trial, benchInput(cfg, trial.id));
      out.push({ id: trial.id, area: trial.area, writerKey: trial.writerKey, decision });
      if (options.dryRun || decision.action === "wait") continue;
      if (decision.action === "adopt") {
        const parent = trial.parentId ? getHarness(db, trial.parentId) : null;
        if (parent && parent.state === "adopted") setHarnessState(db, parent.id, "retired", `replaced by ${trial.id}`, now);
        setHarnessState(db, trial.id, "adopted", decision.reason, now);
        ctx.log(`harness ${projectId}:${trial.area}:${trial.writerKey}: adopted ${trial.id}: ${decision.reason}`);
      } else {
        setHarnessState(db, trial.id, "retired", decision.reason, now);
        ctx.log(`harness ${projectId}:${trial.area}:${trial.writerKey}: retired ${trial.id}: ${decision.reason}`);
      }
      ctx.realtime.notify(projectId, "harness");
      void reflect(trial.id).catch((cause) => ctx.log(`harness reflection for ${trial.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
    return out;
  }

  /**
   * Step `prepare` of `lp.harness-reflect`: the evidence of both arms of a decided trial is written beside the repository and the reflection's mission
   * is made. A trial that has not decided is skipped; one with no reachable folder fails the step.
   */
  async function prepareReflect(trialId: string): Promise<{ status: "ready" | "skipped"; detail: string; projectId: string; hostId: string; path: string; folder: string; mission: string }> {
    const none = { projectId: "", hostId: "", path: "", folder: "", mission: "" };
    const trial = getHarness(db, trialId);
    if (!trial || !["adopted", "retired"].includes(trial.state)) return { status: "skipped", detail: "the trial has not decided", ...none };
    const cfg = await config(trial.projectId);
    const where = await place(trial.projectId, trial.area);
    if (!where) throw new Error("no reachable folder for the reflection");
    const parent = trial.parentId ? getHarness(db, trial.parentId) : null;
    const rows = trialAttempts(db, trial);
    const pick = (arm: "new" | "old") => rows.filter((row) => row.arm === arm).slice(-3).map((row) => row.attemptId);
    const attempts = await collectEvidence(trial.projectId, trial.area, trial.writerKey, 6, 0, { attemptIds: [...pick("new"), ...pick("old")] });
    const decision = decideTrial(rows, trial.trialStartedAt ?? trial.createdAt, Date.now(), cfg.trial, benchInput(cfg, trial.id));
    const files = evidenceFiles({
      area: trial.area, writerKey: trial.writerKey, attempts, harness: trial.tree, baseHarness: parent?.tree ?? {}, library: libraryEntries(trial.projectId, trial.area),
      pool: [{ label: "candidate", tree: trial.tree, diff: treeDiff(parent?.tree ?? {}, trial.tree), notes: trial.notes ?? "" }],
      decisions: { trial: `${trial.state}: ${trial.reason ?? ""}\n\n${JSON.stringify(decision.arms, null, 2)}`, editors: trial.notes ?? "" },
    });
    const folder = `${HARNESS_DIR}-edit/${slug(trial.area || "project")}__${slug(trial.writerKey)}/reflect-${trial.id}`;
    await writeFiles(where, folder, files);
    const mission = harnessMission(`${experiencePrompt({ area: trial.area || "(whole project)", writerKey: trial.writerKey })}\n\n# WHAT HAPPENED\n\nThe candidate (context/pool/candidate/, also context/harness/) was ${trial.state}: ${trial.reason ?? ""}. Attempts of both arms are under context/attempts/ (brief.md names the tree and arm). Compare context/harness/ with context/base_harness/.`, evidenceLayout(files));
    return { status: "ready", detail: "", projectId: trial.projectId, hostId: where.hostId, path: where.path, folder, mission };
  }

  /** Step `reflect` of `lp.harness-reflect`: the one session that reads both arms. A session that fails fails the step. */
  async function reflectSession(step: HarnessStep, trialId: string, prepared: { projectId: string; hostId: string; path: string; folder: string; mission: string }): Promise<string> {
    const trial = getHarness(db, trialId);
    if (!trial) throw new Error(`harness ${trialId} is gone`);
    const result = await session({ projectId: prepared.projectId, where: { hostId: prepared.hostId, path: prepared.path }, folder: prepared.folder, cfg: await config(prepared.projectId), harvest: false, role: "harness-reflection", model: "reflect",
      title: `Lane Pilot harness reflection: ${trial.area || "project"} / ${trial.writerKey}`, mission: prepared.mission, step, key: "reflect" });
    if (result.error) throw new Error(result.error);
    return result.text;
  }

  /** Step `record` of `lp.harness-reflect`: what each edit did and the one lesson that transfers, into the library and the rules pipeline. */
  function recordReflect(trialId: string, answer: string): { status: "done"; detail: string } {
    const trial = getHarness(db, trialId);
    if (!trial) throw new Error(`harness ${trialId} is gone`);
    const edits = parseEdits(answer);
    const experience = parseExperience(answer);
    const supported = experienceIsSupported(experience, edits);
    let ruleId: string | null = null;
    if (experience && supported) {
      const proposal = upsertLessonProposal(db, trial.projectId, { rule: experience.lesson, evidence: `${experience.evidence} (harness ${trial.id}, ${trial.state})`, audience: "writer", form: inferForm(experience.lesson), cue: experience.cue, confidence: experience.confidence || null });
      ruleId = proposal.id;
    }
    const editsMd = edits.map((row) => `component: ${row.component}\ncandidates: ${row.candidates}\nchange: ${row.change}\nobserved: ${row.observed}\nverdict: ${row.verdict}`).join("\n");
    saveExperience(db, { harnessId: trial.id, editsMd, cue: supported ? experience!.cue : null, lesson: supported ? experience!.lesson : null, evidence: supported ? experience!.evidence : null, confidence: supported ? experience!.confidence || null : null, ruleId });
    ctx.realtime.notify(trial.projectId, "harness");
    return { status: "done", detail: `${edits.length} edit rows, ${supported ? `lesson → ${ruleId}` : "NO_ENTRY"}` };
  }

  /** After a trial decided: what each edit did, and the one lesson that transfers, as a run of the graph `lp.harness-reflect` (named by the trial: it runs once). */
  async function reflect(trialId: string): Promise<{ status: "done" | "skipped" | "failed"; detail: string }> {
    const trial = getHarness(db, trialId);
    if (!trial || !["adopted", "retired"].includes(trial.state)) return { status: "skipped", detail: "the trial has not decided" };
    const workflow = services.workflowEngine.resolveWorkflow(HARNESS_REFLECT_WORKFLOW);
    if (!workflow) return { status: "failed", detail: `built-in workflow ${HARNESS_REFLECT_WORKFLOW} is not loaded` };
    try {
      const started = services.workflowEngine.start({
        workflow, key: `harness-reflect:${trialId}`, link: { projectId: trial.projectId }, runtime: { ctx, services, pmThreadId: null, projectId: trial.projectId, runId: null } satisfies ChainRuntime,
        inputs: { project_id: trial.projectId, trial_id: trialId },
      });
      const summary = await started.done;
      if (summary.status !== "succeeded") return { status: "failed", detail: summary.error ?? summary.reason ?? `the reflection ${summary.status}` };
      const out = summary.output ?? {};
      return { status: out.status === "done" ? "done" : "skipped", detail: String(out.detail ?? "") };
    } catch (cause) {
      return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  return { benchInput, evaluateTrials, prepareReflect, reflectSession, recordReflect, reflect };
}
