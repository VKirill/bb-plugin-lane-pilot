import aboutSite from "../../workflows/about-site.json";
import analyzeCode from "../../workflows/analyze-code.json";
import analyzePlanExecute from "../../workflows/analyze-plan-execute.json";
import blueprintDriven from "../../workflows/blueprint-driven.json";
import brainstormDriven from "../../workflows/brainstorm-driven.json";
import codeReview from "../../workflows/code-review.json";
import companion from "../../workflows/companion.json";
import debug from "../../workflows/debug.json";
import deploy from "../../workflows/deploy.json";
import fullLifecycle from "../../workflows/full-lifecycle.json";
import grillDriven from "../../workflows/grill-driven.json";
import grillPlan from "../../workflows/grill-plan.json";
import impeccableBuild from "../../workflows/impeccable-build.json";
import insPost from "../../workflows/ins.post.json";
import insightsPost from "../../workflows/insights-post.json";
import invoiceSend from "../../workflows/invoice-send.json";
import issueDiscover from "../../workflows/issue-discover.json";
import issueFull from "../../workflows/issue-full.json";
import issueQuick from "../../workflows/issue-quick.json";
import lpTaskPipeline from "../../workflows/lp-task-pipeline.json";
import lpAnalyze from "../../workflows/lp.analyze.json";
import lpBrainstorm from "../../workflows/lp.brainstorm.json";
import lpBuild from "../../workflows/lp.build.json";
import lpClose from "../../workflows/lp.close.json";
import lpPlan from "../../workflows/lp.plan.json";
import lpReview from "../../workflows/lp.review.json";
import milestoneClose from "../../workflows/milestone-close.json";
import planOnly from "../../workflows/plan-only.json";
import qualityLoop from "../../workflows/quality-loop.json";
import reels from "../../workflows/reels.json";
import resume from "../../workflows/resume.json";
import refactor from "../../workflows/refactor.json";
import retrospective from "../../workflows/retrospective.json";
import reviewFix from "../../workflows/review-fix.json";
import roadmapDriven from "../../workflows/roadmap-driven.json";
import securityAudit from "../../workflows/security-audit.json";
import seoCocoon from "../../workflows/seo-cocoon.json";
import testGen from "../../workflows/test-gen.json";
import uiAudit from "../../workflows/ui-audit.json";
import webResearch from "../../workflows/web-research.json";
import xToTelegramDigest from "../../workflows/x-to-telegram-digest.json";
import yearReview from "../../workflows/year-review.json";
import type { Workflow } from "./schema";
import { parseWorkflow } from "./validate";

/** The workflows that ship with Lane Pilot (`workflows/*.json`, inlined by the bundler). Add a file here to add one (a test checks that every file is listed). */
export const BUILTIN_SOURCES: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: "about-site.json", value: aboutSite },
  { name: "analyze-code.json", value: analyzeCode },
  { name: "analyze-plan-execute.json", value: analyzePlanExecute },
  { name: "blueprint-driven.json", value: blueprintDriven },
  { name: "brainstorm-driven.json", value: brainstormDriven },
  { name: "code-review.json", value: codeReview },
  { name: "companion.json", value: companion },
  { name: "debug.json", value: debug },
  { name: "deploy.json", value: deploy },
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
  { name: "lp-task-pipeline.json", value: lpTaskPipeline },
  { name: "lp.analyze.json", value: lpAnalyze },
  { name: "lp.brainstorm.json", value: lpBrainstorm },
  { name: "lp.build.json", value: lpBuild },
  { name: "lp.close.json", value: lpClose },
  { name: "lp.plan.json", value: lpPlan },
  { name: "lp.review.json", value: lpReview },
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
];

/** The per-task pipeline every dispatch runs through (PM read, critiques, ownership base, writer). */
export const LP_TASK_PIPELINE = "lp-task-pipeline";
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
