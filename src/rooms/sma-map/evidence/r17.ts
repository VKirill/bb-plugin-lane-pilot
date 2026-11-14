// Region 17 · Agent roles (subagents) — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, wfRun, wfStep } from "./types";

export default {
  n1369: { trace: wfStep("ai-integration-phase", "research") },
  n1370: { trace: wfStep("ai-integration-phase", "research") },
  n1371: { trace: wfStep("ai-integration-phase", "spec") },
  n1374: { trace: wfRun("review-fix") },
  n1380: { trace: wfStep("security-audit", "threat_model") },
  n1381: { trace: wfStep("ui-audit", "review_doc") },
  n1383: { trace: wfStep("eval-review", "review") },
  n1392: { trace: wfStep("lp.plan", "plan") },
  n1393: { trace: wfRun("grill-plan") },
  n1395: { trace: wfStep("lp.analyze", "gather") },
  n1396: { trace: wfRun("web-research") },
  n1397: { trace: wfRun("roadmap-driven") },
} satisfies RegionEvidence;
