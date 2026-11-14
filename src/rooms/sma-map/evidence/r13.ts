// Region 13 · Guard tools — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The guard tools (house words, ids, contract reading, parity) live in src/rooms/guard-tools/guard-tools.ts; tests/helpers/guard-tools.ts re-exports them.
// A guard tool runs in the test suite or the publish gate and writes no row to the hub database: its trace is its own prove() line in the
// region scene scripts/lp_drill/scenes/sma_r13.py (docs/sma-evidence.md).
import { distort, drill, entry, flip, rows, skipWrite, type RegionEvidence } from "./types";

const GUARDS = "src/rooms/guard-tools/guard-tools.ts";

export default {
  n1036: { mutation: flip(GUARDS, "|| COLOUR_LITERAL.test(value)", "|| !COLOUR_LITERAL.test(value)"), trace: drill("sma_r13") },
  n1037: { mutation: flip(GUARDS, ".filter(([, value]) => INTERNAL_ID.test(value)).map(([key]) => key)", ".filter(([, value]) => !INTERNAL_ID.test(value)).map(([key]) => key)"), reach: entry("the test run scans the catalogs a person reads"), trace: drill("sma_r13") },
  n1038: { mutation: flip("scripts/lp-ship.ts", "if (strict) for (const hit of leakFindings(", "if (!strict) for (const hit of leakFindings("), reach: entry("the owner publishes the package (npm prepublishOnly runs the gate) or the test suite runs"), trace: drill("sma_r13") },
  n1039: { mutation: flip(GUARDS, "if (explained[`${method}.${field}`] !== undefined) continue;", "if (explained[`${method}.${field}`] === undefined) continue;"), trace: drill("sma_r13") },
  n1040: { mutation: distort(GUARDS, '"for the CLI (scripts/lp-canary.sh) and the PM alert, not for a screen"', '"CLI only"'), trace: drill("sma_r13") },
  n1041: { mutation: flip(GUARDS, "if (!read) unread.push(`${method}.${field}`);", "if (read) unread.push(`${method}.${field}`);"), reach: entry("the test suite runs"), trace: drill("sma_r13") },
  n1042: { mutation: distort("src/rooms/native-agent/terminal-parity.ts", "return { layer, same: null, detail: NOT_COMPARED", "return { layer, same: true, detail: NOT_COMPARED"), reach: entry("the owner asks for the session and terminal parity of an attempt"), trace: drill("sma_r13") },
  n1043: { mutation: flip(GUARDS, "onlyTerminal: [...b].filter((tool) => !a.has(tool)).sort()", "onlyTerminal: [...b].filter((tool) => a.has(tool)).sort()"), reach: entry("the test suite runs"), trace: drill("sma_r13") },
  n1044: { mutation: flip("src/rooms/native-agent/server/helper-probe.ts", '|| !Number.isFinite(parts[key])) return', '|| Number.isFinite(parts[key])) return'), reach: entry("the capability sweep probes a provider's accounting cell"), trace: rows("lane_pilot_capability", "at", "capability = 'accounting' AND state = 'supported' AND provider_id = 'codex'") },
  n1045: { mutation: skipWrite("src/rooms/capability/server/capability.ts", 'saveReceipt(db, { providerId: item.providerId, version: item.version, capability, state, model: item.model, detail: result.ok ? null : (result.reason ?? "no answer").slice(0, 500), at: now });'), reach: entry("a provider's installed version has no receipt for a capability cell (the sweep, or capabilities --probe)"), trace: rows("lane_pilot_capability", "at", "capability = 'pause' OR capability LIKE 'documentary.%'") },
  n1046: { mutation: flip("src/rooms/storage/attempts-store/project-reads.ts", "WHERE a.attempt_no=(SELECT MAX(b.attempt_no) FROM lane_pilot_attempt b WHERE b.task_id=a.task_id)\n      AND a.state NOT IN ('accepted','canceled'", "WHERE a.attempt_no=(SELECT MIN(b.attempt_no) FROM lane_pilot_attempt b WHERE b.task_id=a.task_id)\n      AND a.state NOT IN ('accepted','canceled'"), reach: entry("the owner or a PM tool asks for the failure journal") },
  n1047: { mutation: flip("scripts/lp_drill/scenes/hub_outage.py", '"ready": rc2 == 0 and "ready:" in ready', '"ready": rc2 != 0 and "ready:" in ready'), reach: entry("the outage drill runs its live pass (LP_DRILL_WATCHDOG_LIVE=1 on a named scene)") },
} satisfies RegionEvidence;
