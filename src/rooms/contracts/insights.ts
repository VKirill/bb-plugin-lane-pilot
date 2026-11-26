/** The analyzer pick and runner surface shared with night-graphs, pm-replay, and memory-eval. */
export type AnalyzerSelection = { providerId: string; model: string; reasoningLevel: string; serviceTier: "default" | "fast" | null };

export interface RuleScanSurface {
  analyzerFor?(projectId: string, place?: { hostId: string; path: string } | null, options?: { avoidProvider?: string }): Promise<AnalyzerSelection | null>;
  runAnalyzer(projectId: string, title: string, prompt: string, place: { hostId: string; path: string }, analyzer: AnalyzerSelection, metadata: Record<string, unknown>, role?: string): Promise<string>;
}
