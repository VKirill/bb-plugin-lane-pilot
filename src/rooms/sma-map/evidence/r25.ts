// Region 25 · Receipts and evidence — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, drill, flip, rows, receipt, seedEntry, wrongTarget, type RegionEvidence } from "./types";

const RECEIPTS = "src/rooms/tools/server/receipts.ts";
const ROLLBACK = "src/rooms/rollback/server/rollback.ts";
const FORECAST = "src/rooms/forecast/logic.ts";
const REPORT = "src/rooms/forecast/server/report.ts";
const MUTATORS = "src/rooms/checkers/mutators.ts";
const CRITIQUE = "src/rooms/critique/code-critique.ts";
const BASELINE = "src/rooms/baseline/logic.ts";
const WIRES = "src/rooms/wires/logic.ts";

export default {
  // The chain hashes each receipt's input and output: a forged output hash moves the tip (test: a done claim names the command and the hash of its output).
  n1680: { reach: seedEntry("the owner runs the command"), mutation: distort(RECEIPTS, "${row.inputSha256 ?? \"\"}\\n${row.outputSha256 ?? \"\"}", "${row.inputSha256 ?? \"\"}\\n${row.inputSha256 ?? \"\"}"), trace: receipt("verification", "passed") },
  n1681: { reach: seedEntry("the owner runs the command"), mutation: wrongTarget(ROLLBACK, "${nonce()}`, change.mergeCommit, \"rollback\")", "${nonce()}`, change.mergeParent ?? change.mergeCommit, \"rollback\")"), trace: drill("sma_r25") },
  n1682: { reach: seedEntry("the owner runs the command"), mutation: distort(FORECAST, "error: fact.files - forecast.files }", "error: forecast.files - fact.files }"), trace: drill("sma_r25") },
  n1683: { reach: seedEntry("the owner runs the command"), mutation: flip(FORECAST, "firstTryHit: round(scores.filter((row) => row.firstTry.hit).length / n),", "firstTryHit: round(scores.filter((row) => !row.firstTry.hit).length / n),"), trace: drill("sma_r25") },
  n1684: { reach: seedEntry("the owner runs the command"), mutation: flip(CRITIQUE, "const inline = inlineTotal <= INLINE_CHANGE_MAX_BYTES;", "const inline = inlineTotal > INLINE_CHANGE_MAX_BYTES;"), trace: receipt("code-critique", ["passed", "failed"]) },
  n1685: { reach: seedEntry("the owner runs the command"), mutation: wrongTarget(MUTATORS, "    changes: mutation.changes,\n    claim: honestClaim(input),", "    changes: input.changes,\n    claim: honestClaim(input),"), trace: drill("sma_r25") },
  n1686: { reach: seedEntry("the owner runs the command"), mutation: flip(REPORT, "Math.abs(skepticScore.files.error) < Math.abs(score.files.error)", "Math.abs(skepticScore.files.error) > Math.abs(score.files.error)"), trace: drill("sma_r25") },
  n1687: { reach: seedEntry("the owner runs the command"), mutation: wrongTarget(REPORT, "calibrate(forecastReport(db, { projectId, days: 60 }).scored, current).overall", "calibrate(forecastReport(db, { projectId, days: 60 }).scored).overall"), trace: drill("sma_r25") },
  n1688: { reach: seedEntry("the owner runs the command"), mutation: flip("src/rooms/phase/server/driver-journal.ts", "if (output.status !== \"open\") return null;", "if (output.status === \"open\") return null;"), trace: drill("sma_r25") },
  n1689: { reach: seedEntry("the owner runs the command"), mutation: flip(BASELINE, "if (checks.every((check) => check.status === \"green\")) return \"already_built\";", "if (checks.some((check) => check.status === \"green\")) return \"already_built\";"), trace: rows("lane_pilot_baseline", "at") },
  n1690: { reach: seedEntry("the owner runs the command"), mutation: flip(WIRES, "grep -q -F -e ${q(to)} \"$f\"", "grep -q -v -F -e ${q(to)} \"$f\""), trace: drill("sma_r25") },
  // The task manifest is the evidence passport: every row carries its sha256 and producer (docs/task-folder.md).
  n1691: { reach: seedEntry("the owner runs the command"), mutation: distort("src/rooms/storage/task-manifest.ts", "plugin_version: row.plugin_version,\n      sha256: row.sha256,", "plugin_version: row.plugin_version,\n      sha256: row.path,"), trace: drill("task_home") },
  n1692: { reach: seedEntry("the owner runs the command"), mutation: flip(RECEIPTS, "receiptChain(db, runId, taskId).tip === tip;", "receiptChain(db, runId, taskId).tip !== tip;"), trace: drill("sma_r25") },
  n1693: { reach: seedEntry("the owner runs the command"), mutation: flip(RECEIPTS, "receipt.state === \"skipped\" || result.table === \"missing\"", "receipt.state !== \"skipped\" || result.table === \"missing\""), trace: drill("sma_r25") },
  n1694: { reach: seedEntry("the owner runs the command"), mutation: distort(ROLLBACK, "receipt(t, \"revert\", \"merged\", summary,", "receipt(t, \"revert\", \"dry_run\", summary,"), trace: drill("sma_r25") },
  n1695: { reach: seedEntry("the owner runs the command"), mutation: flip(RECEIPTS, "clear: items.every((item) => item.disposition === \"keep with its term\")", "clear: items.every((item) => item.disposition !== \"keep with its term\")"), trace: drill("sma_r25") },
  n1696: { mutation: flip(FORECAST, "hit: forecast.checks_pass_first_try === fact.firstTry }", "hit: forecast.checks_pass_first_try !== fact.firstTry }"), trace: drill("sma_r25") },
  n1697: { mutation: flip(FORECAST, ".sort((a, b) => b.tasks - a.tasks || a.area.localeCompare(b.area))", ".sort((a, b) => a.tasks - b.tasks || a.area.localeCompare(b.area))"), trace: drill("sma_r25") },
  n1698: { mutation: distort(MUTATORS, "after: \"a change outside owns_paths\\n\"", "after: \"a planted change outside owns_paths\\n\""), trace: drill("sma_r25") },
  n1699: { mutation: flip("src/rooms/tasks/rails.ts", "/^(M|D|R)/.test(change.status)", "/^(A|D|R)/.test(change.status)"), trace: drill("sma_r25") },
  n1700: { mutation: flip(FORECAST, "calibration.filesMae <= 2 && calibration.firstTryHit >= 0.7", "calibration.filesMae < 2 && calibration.firstTryHit >= 0.7"), trace: drill("sma_r25") },
  n1701: { mutation: flip(FORECAST, "rows.filter((row) => row.model === model)", "rows.filter((row) => row.model !== model)"), trace: drill("sma_r25") },
  n1702: { mutation: flip(CRITIQUE, "return after.length > 0 && after.every(", "return after.length === 0 && after.every("), trace: drill("sma_r25") },
  n1703: { mutation: distort(FORECAST, "{ undeclared: diff(added, declared), notAdded: diff(declared, added) }", "{ undeclared: diff(declared, added), notAdded: diff(added, declared) }"), trace: drill("sma_r25") },
  n1704: { mutation: distort(RECEIPTS, "disposition: \"fix the checker, then run `bb lane-pilot checkers` again\"", "disposition: \"keep with its term\""), trace: drill("sma_r25") },
  n1705: { mutation: distort(RECEIPTS, "...stages.map((row) => `- ${row.stage_id}: ${row.state}`)", "...stages.map((row) => `- ${row.stage_id}: passed`)"), trace: drill("sma_r25") },
  n1706: { mutation: flip(BASELINE, "? \"red\" : \"partial\"", "? \"partial\" : \"red\""), trace: rows("lane_pilot_baseline", "at", "state = 'ran'") },
  n1707: { mutation: distort(WIRES, "to: wire.chain[hop + 1]!, file:", "to: wire.chain[hop]!, file:"), trace: drill("sma_r25") },
  n1708: { mutation: flip("src/rooms/tasks/plan-fact.ts", "known.some(([a, b]) => from <= b && to >= a)", "known.some(([a, b]) => from <= a && to >= a)"), trace: receipt("plan-fact", ["passed", "failed"]) },
  n1709: { mutation: distort(ROLLBACK, "cause: mark?.cause ?? \"rolled back, cause unknown\"", "cause: mark?.cause ?? reverted.summary"), trace: drill("sma_r25") },
} satisfies RegionEvidence;
