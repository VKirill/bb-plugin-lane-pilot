import aboutSite from "../../../workflows/about-site.json";
import agentRoutine from "../../../workflows/agent-routine.json";
import analyzeCode from "../../../workflows/analyze-code.json";
import analyzePlanExecute from "../../../workflows/analyze-plan-execute.json";
import blueprintDriven from "../../../workflows/blueprint-driven.json";
import browserStep from "../../../workflows/browser-step.json";
import lpBrowserQa from "../../../workflows/lp.browser-qa.json";
import brainstormDriven from "../../../workflows/brainstorm-driven.json";
import codeReview from "../../../workflows/code-review.json";
import companion from "../../../workflows/companion.json";
import council from "../../../workflows/council.json";
import debug from "../../../workflows/debug.json";
import deploy from "../../../workflows/deploy.json";
import errand from "../../../workflows/errand.json";
import fullLifecycle from "../../../workflows/full-lifecycle.json";
import grillDriven from "../../../workflows/grill-driven.json";
import grillPlan from "../../../workflows/grill-plan.json";
import impeccableBuild from "../../../workflows/impeccable-build.json";
import insPost from "../../../workflows/ins.post.json";
import insightsPost from "../../../workflows/insights-post.json";
import invoiceSend from "../../../workflows/invoice-send.json";
import issueDiscover from "../../../workflows/issue-discover.json";
import issueFull from "../../../workflows/issue-full.json";
import issueQuick from "../../../workflows/issue-quick.json";
import issueQuickLegacy from "../../../workflows/issue-quick-legacy.json";
import issueBatch from "../../../workflows/issue-batch.json";
import lpTaskPipeline from "../../../workflows/lp-task-pipeline.json";
import lpAfterAccept from "../../../workflows/lp.after-accept.json";
import lpDocsMaintenance from "../../../workflows/lp.docs-maintenance.json";
import lpDocsNight from "../../../workflows/lp.docs-night.json";
import lpAnalyze from "../../../workflows/lp.analyze.json";
import lpBrainstorm from "../../../workflows/lp.brainstorm.json";
import lpBuild from "../../../workflows/lp.build.json";
import lpClose from "../../../workflows/lp.close.json";
import lpDraw from "../../../workflows/lp.draw.json";
import lpPlan from "../../../workflows/lp.plan.json";
import lpReview from "../../../workflows/lp.review.json";
import lpHarnessEdit from "../../../workflows/lp.harness-edit.json";
import lpCriticEdit from "../../../workflows/lp.critic-edit.json";
import lpHarnessReflect from "../../../workflows/lp.harness-reflect.json";
import lpWallHunt from "../../../workflows/lp.wall-hunt.json";
import lpRoute from "../../../workflows/lp.route.json";
import lpRulesAsk from "../../../workflows/lp.rules-ask.json";
import lpRulesScan from "../../../workflows/lp.rules-scan.json";
import lpSelfRepair from "../../../workflows/lp.self-repair.json";
import milestoneClose from "../../../workflows/milestone-close.json";
import planOnly from "../../../workflows/plan-only.json";
import qualityLoop from "../../../workflows/quality-loop.json";
import reels from "../../../workflows/reels.json";
import resume from "../../../workflows/resume.json";
import refactor from "../../../workflows/refactor.json";
import retrospective from "../../../workflows/retrospective.json";
import reviewFix from "../../../workflows/review-fix.json";
import roadmapDriven from "../../../workflows/roadmap-driven.json";
import securityAudit from "../../../workflows/security-audit.json";
import seoCocoon from "../../../workflows/seo-cocoon.json";
import testGen from "../../../workflows/test-gen.json";
import uiAudit from "../../../workflows/ui-audit.json";
import webResearch from "../../../workflows/web-research.json";
import xToTelegramDigest from "../../../workflows/x-to-telegram-digest.json";
import yearReview from "../../../workflows/year-review.json";
import validatePhase from "../../../workflows/validate-phase.json";
import evalReview from "../../../workflows/eval-review.json";
import aiIntegrationPhase from "../../../workflows/ai-integration-phase.json";
import spike from "../../../workflows/spike.json";
import specialist from "../../../workflows/specialist.json";
import ship from "../../../workflows/ship.json";
import prBranch from "../../../workflows/pr-branch.json";
import cleanup from "../../../workflows/cleanup.json";
import newMilestone from "../../../workflows/new-milestone.json";
import planReviewConvergence from "../../../workflows/plan-review-convergence.json";
import projectStart from "../../../workflows/project-start.json";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { parseWorkflow } from "@lane-pilot/workflow-engine";
import { gateVocabularyLines } from "../tasks";

/** The planner's instructions with the gate vocabulary: the plan's acceptance items are judged by those words (tasks/gate-vocabulary.ts). */
const withGateVocabulary = (workflow: { nodes: Array<{ id: string; prompt?: string }> }): unknown => ({
  ...workflow,
  nodes: workflow.nodes.map((node) => node.id === "plan" && node.prompt ? { ...node, prompt: `${node.prompt}\n\n${gateVocabularyLines().join("\n")}` } : node),
});

/** The workflows that ship with Lane Pilot (`workflows/*.json`, inlined by the bundler). Add a file here to add one (a test checks that every file is listed). */
export const BUILTIN_SOURCES: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "about-site.json", value: aboutSite },
  { name: "agent-routine.json", value: agentRoutine },
  { name: "analyze-code.json", value: analyzeCode },
  { name: "analyze-plan-execute.json", value: analyzePlanExecute },
  { name: "blueprint-driven.json", value: blueprintDriven },
  { name: "brainstorm-driven.json", value: brainstormDriven },
  { name: "browser-step.json", value: browserStep },
  { name: "lp.browser-qa.json", value: lpBrowserQa },
  { name: "code-review.json", value: codeReview },
  { name: "companion.json", value: companion },
  { name: "council.json", value: council },
  { name: "debug.json", value: debug },
  { name: "deploy.json", value: deploy },
  { name: "errand.json", value: errand },
  { name: "full-lifecycle.json", value: fullLifecycle },
  { name: "grill-driven.json", value: grillDriven },
  { name: "grill-plan.json", value: grillPlan },
  { name: "impeccable-build.json", value: impeccableBuild },
  { name: "ins.post.json", value: insPost },
  { name: "insights-post.json", value: insightsPost },
  { name: "invoice-send.json", value: invoiceSend },
  { name: "issue-discover.json", value: issueDiscover },
  { name: "issue-full.json", value: issueFull },
  { name: "issue-quick.json", value: issueQuick },
  { name: "issue-quick-legacy.json", value: issueQuickLegacy },
  { name: "issue-batch.json", value: issueBatch },
  { name: "lp-task-pipeline.json", value: lpTaskPipeline },
  { name: "lp.after-accept.json", value: lpAfterAccept },
  { name: "lp.docs-maintenance.json", value: lpDocsMaintenance },
  { name: "lp.docs-night.json", value: lpDocsNight },
  { name: "lp.analyze.json", value: lpAnalyze },
  { name: "lp.brainstorm.json", value: lpBrainstorm },
  { name: "lp.build.json", value: lpBuild },
  { name: "lp.close.json", value: lpClose },
  { name: "lp.draw.json", value: lpDraw },
  { name: "lp.plan.json", value: withGateVocabulary(lpPlan as never) },
  { name: "lp.review.json", value: lpReview },
  { name: "lp.harness-edit.json", value: lpHarnessEdit },
  { name: "lp.critic-edit.json", value: lpCriticEdit },
  { name: "lp.harness-reflect.json", value: lpHarnessReflect },
  { name: "lp.wall-hunt.json", value: lpWallHunt },
  { name: "lp.route.json", value: lpRoute },
  { name: "lp.rules-ask.json", value: lpRulesAsk },
  { name: "lp.rules-scan.json", value: lpRulesScan },
  { name: "lp.self-repair.json", value: lpSelfRepair },
  { name: "milestone-close.json", value: milestoneClose },
  { name: "plan-only.json", value: planOnly },
  { name: "quality-loop.json", value: qualityLoop },
  { name: "reels.json", value: reels },
  { name: "resume.json", value: resume },
  { name: "refactor.json", value: refactor },
  { name: "retrospective.json", value: retrospective },
  { name: "review-fix.json", value: reviewFix },
  { name: "roadmap-driven.json", value: roadmapDriven },
  { name: "security-audit.json", value: securityAudit },
  { name: "seo-cocoon.json", value: seoCocoon },
  { name: "test-gen.json", value: testGen },
  { name: "ui-audit.json", value: uiAudit },
  { name: "web-research.json", value: webResearch },
  { name: "x-to-telegram-digest.json", value: xToTelegramDigest },
  { name: "year-review.json", value: yearReview },
  { name: "validate-phase.json", value: validatePhase },
  { name: "eval-review.json", value: evalReview },
  { name: "ai-integration-phase.json", value: aiIntegrationPhase },
  { name: "spike.json", value: spike },
  { name: "specialist.json", value: specialist },
  { name: "ship.json", value: ship },
  { name: "pr-branch.json", value: prBranch },
  { name: "cleanup.json", value: cleanup },
  { name: "new-milestone.json", value: newMilestone },
  { name: "plan-review-convergence.json", value: planReviewConvergence },
  { name: "project-start.json", value: projectStart },
];

/** The per-task pipeline every dispatch runs through (PM read, critiques, ownership base, writer). */
export const LP_TASK_PIPELINE = "lp-task-pipeline";
/** The graph that runs once a task is accepted: memory maintenance and project life, side by side (started by the merge, never offered). */
export const AFTER_ACCEPT = "lp.after-accept";
/** The graph of one docs unit of the night (prepare, write, verify, commit), started by the nightly docs schedules. */
export const DOCS_NIGHT = "lp.docs-night";
/** The graph of the docs upkeep of one accepted task, started by the hourly docs-maintenance schedule. */
export const DOCS_MAINTENANCE = "lp.docs-maintenance";
/** The graph of one self-repair (worktree, repair thread, verdict and merge), started by the self-repair watcher. */
export const SELF_REPAIR = "lp.self-repair";
/** The graph of the router's model step (`lane_pilot_route` escalates a request System One cannot decide alone): one read-only helper thread, a real run of its own. */
export const ROUTE_WORKFLOW = "lp.route";
/** The outer chain of the chains spec: analyze, plan, build, check, close. */
export const ANALYZE_PLAN_EXECUTE = "analyze-plan-execute";

const parsed = new Map<string, Workflow>();
// A fragment is parsed before the chains that call it, so the files are loaded in rounds until every reference resolves.
let pending = BUILTIN_SOURCES.map((source) => source.value);
for (let round = 0; pending.length && round < 5; round += 1) {
  const failed: unknown[] = [];
  for (const value of pending) {
    try { const workflow = parseWorkflow(value, { resolve: (id) => parsed.get(id) ?? null }); parsed.set(workflow.id, workflow); }
    catch (cause) { if (round === 4) throw cause; failed.push(value); }
  }
  pending = failed;
}

const order = BUILTIN_SOURCES.map((source) => (source.value as { id: string }).id);
export const builtinWorkflows = (): Workflow[] => order.map((id) => parsed.get(id)!);
export const builtinWorkflow = (id: string, version?: number): Workflow | null => {
  const found = parsed.get(id) ?? null;
  return found && (version === undefined || found.version === version) ? found : null;
};
