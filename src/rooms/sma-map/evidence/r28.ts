// Region 28 · Design training and evaluation — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// These are measurement computations over a fixture set: the journal lives in plugin KV (no timestamp to judge a trace by) and the scores write no
// hub row, so each node's trace is its own prove() line in the region scene scripts/lp_drill/scenes/sma_r28.py. Each mutation distorts a number.
import { distort, drill, entry, flip, type RegionEvidence } from "./types";

const LOGIC = "src/rooms/design-eval/logic.ts";
const TRAINING = "src/rooms/design-eval/training.ts";

export default {
  n1756: { mutation: distort(LOGIC, "all.reduce((a, b) => a + b, 0) / all.length", "all.reduce((a, b) => a + b, 0) / (all.length + 1)"), reach: entry("the owner or the PM measures a page against the rubric (lp-design-eval, or a design pair)"), trace: drill("sma_r28") },
  n1757: { mutation: flip("src/rooms/design-eval/case.ts", "sha(canonicalMeasurements(measurements)) !== row.sha256", "sha(canonicalMeasurements(measurements)) === row.sha256"), trace: drill("sma_r28") },
  n1758: { mutation: distort(TRAINING, "judgeAgrees: share(agrees, judged.length)", "judgeAgrees: share(agrees, n)"), trace: drill("sma_r28") },
  n1759: { mutation: distort(LOGIC, '"tiny_text", "one_h1", "spacing"] as const', '"tiny_text", "h1", "spacing"] as const'), reach: entry("a page or a drawing is scored against the rubric (lp-design-eval, or a design pair)"), trace: drill("sma_r28") },
  n1760: { mutation: flip("src/rooms/design-eval/journal.ts", "keyOf(previous) === key", "keyOf(previous) !== key"), trace: drill("sma_r28") },
  n1761: { mutation: distort(TRAINING, "score! > 3", "score! > 4"), trace: drill("sma_r28") },
  n1762: { mutation: flip("src/rooms/design-eval/pair.ts", 'order === "ab" ? [line("first", scoreA)', 'order === "ba" ? [line("first", scoreA)'), reach: entry("the owner or the PM asks for a paired design judgement of two pages (bb lane-pilot design-pair)"), trace: drill("sma_r28") },
  n1763: { mutation: flip("src/rooms/phase/stages.ts", "items.filter((item) => MOTION.test(", "items.filter((item) => !MOTION.test("), reach: entry("a phase plan with a motion row reaches its design stage"), trace: drill("sma_r28") },
  n1764: { mutation: flip(TRAINING, "missing.length === 0", "missing.length !== 0"), trace: drill("sma_r28") },
  n1765: { mutation: distort(TRAINING, '.replace(/\\s+/g, " ").trim().slice(0, 200)', '.replace(/\\s+/g, " ").trim().slice(0, 20)'), trace: drill("sma_r28") },
  n1766: { mutation: flip(TRAINING, "(ratios.firstPass ?? 0) >= 0.7", "(ratios.firstPass ?? 0) > 0.7"), trace: drill("sma_r28") },
  n1767: { mutation: distort("src/rooms/core/server/phase-reactions.ts", 'update(roles.join("\\n"))', 'update(roles.slice(1).join("\\n"))'), reach: entry("the owner runs bb lane-pilot design-metrics (the journal lines carry the series a drawing was made under)"), trace: drill("sma_r28") },
} satisfies RegionEvidence;
