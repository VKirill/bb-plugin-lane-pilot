import type { RuleProposal } from "@lane-pilot/run-insights";
import type { SqlDb } from "./sql-db";

/** The self-repair rule/insight functions, implemented by src/rooms/self-repair and injected for the rooms that adopt, reject or forget a rule. */
export interface InsightsApi {
  acceptRuleProposal(db: SqlDb, projectId: string, id: string, rule: string, by?: "owner" | "auto", now?: number): RuleProposal;
  adoptRuleProposal(db: SqlDb, projectId: string, id: string, now?: number): RuleProposal | null;
  retireAdoptedRule(db: SqlDb, projectId: string, id: string, reason: string, now?: number): void;
  rejectRuleProposal(db: SqlDb, projectId: string, id: string): RuleProposal;
  deleteMemoryRecord(db: SqlDb, projectId: string, memoryId: string): void;
}

/** The scan's analyzer pick, shared with the learning room's own analyzer calls. */
export type AnalyzerSelection = { providerId: string; model: string; reasoningLevel: string; serviceTier: "default" | "fast" | null };

/** The two rule-scan calls the learning service makes, implemented by src/rooms/self-repair (rule-scan.ts). */
export interface RuleScanSurface {
  analyzerFor(projectId: string, place?: { hostId: string; path: string } | null, options?: { avoidProvider?: string }): Promise<AnalyzerSelection | null>;
  runAnalyzer(projectId: string, title: string, prompt: string, place: { hostId: string; path: string }, analyzer: AnalyzerSelection, metadata: Record<string, unknown>, role?: string): Promise<string>;
}
