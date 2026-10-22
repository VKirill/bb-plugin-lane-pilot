// Public API of coverage: the registry of what proves each stage and mechanism (SMA D1-5), and the CLI that prints it.
export { COVERAGE_USAGE, renderCoverage, runCoverageCli } from "./cli";
export { checkReceipt, codeNodes, coverageRows, holes, summarize, transitionId } from "./model";
export type { CoverageRow, CoverageStatus, CoverageSummary, DrillReceipt } from "./model";
export { COVERAGE, NODE_KINDS, REQUIRED_MECHANISMS } from "./registry";
export type { CoverageEntry, NodeKind } from "./registry";
