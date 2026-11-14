// Region 26 · Self-improvement and measurement — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Almost none of these nodes writes a row to the hub database (they print, or keep a value in the plugin store), so the node-level trace is the
// region scene scripts/lp_drill/scenes/sma_r26.py: its own prove() line per node. The ladder is the exception: the nightly scan logs a tier event.
import { distort, drill, entry, flip, rows, seedEntry, type RegionEvidence } from "./types";

const SELF = "src/rooms/tools/server/self-improve.ts";
const MEMORY_COMMAND = "src/rooms/memory-eval/server/command.ts";
const EXAM = "src/rooms/policy/exam.ts";
const BENCH_COMPARE = "src/rooms/bench/compare.ts";
const SCENE = drill("sma_r26");

export default {
  n1710: { mutation: flip(SELF, 'if (!switchOn(settings, "curriculum.weekly")) return null;', 'if (switchOn(settings, "curriculum.weekly")) return null;'), reach: entry("the hub's Monday 09:00 schedule runs the weekly curriculum job", { "curriculum.weekly": "on" }), trace: SCENE },
  n1711: { mutation: flip("src/rooms/rule-forms/cli.ts", 'else if (move !== "stay") lines.push(', 'else if (move === "stay") lines.push('), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1712: { mutation: flip("src/rooms/policy/mine.ts", "if (have.has(id)) continue;", "if (!have.has(id)) continue;"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1713: { mutation: flip(EXAM, "const ok = answer.tier === item.expected;", "const ok = answer.tier !== item.expected;"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1714: { mutation: flip("src/rooms/bench/service.ts", "const toRun = input.arms.filter((spec) => !listRuns(", "const toRun = input.arms.filter((spec) => listRuns("), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1715: { mutation: flip("src/rooms/bench/cli.ts", "return out(flags.json ? metrics : renderBaseline(metrics));", "return out(flags.json ? renderBaseline(metrics) : metrics);"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1716: { mutation: distort(MEMORY_COMMAND, "const seed = flags.seed ? Number(flags.seed) : 1;", "const seed = flags.seed ? 1 : 1;"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1717: { mutation: flip(MEMORY_COMMAND, 'const northStar = flags["north-star"] && extras.northStar ? extras.northStar() : null;', 'const northStar = !flags["north-star"] && extras.northStar ? extras.northStar() : null;'), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1718: { mutation: flip(SELF, "if (commit && subject && /(?<![", "if (commit && subject && !/(?<!["), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1719: { mutation: flip(SELF, ".filter(([, n]) => n >= 3)", ".filter(([, n]) => n > 3)"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1720: { mutation: distort("src/rooms/tools/server/cli-inspect.ts", '{ heading:"Cost per verified result (30 days)", rows:costPerVerified(db) as never },', '{ heading:"Cost per verified result (30 days)", rows:[] as never },'), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1721: { mutation: distort(SELF, "hit.count += 1;\n    byQuery.set(", "hit.count += 2;\n    byQuery.set("), trace: SCENE },
  n1722: { mutation: flip("packages/run-insights/src/rule-ladder.ts", 'if (stats.recurrences >= thresholds.dropAfterRecurrences && index > 0) return "down";', 'if (stats.recurrences >= thresholds.dropAfterRecurrences && index > 1) return "down";'), trace: rows("lane_pilot_rule_event", "at", "action = 'tier'") },
  n1723: { mutation: distort("src/rooms/policy/live-exam.ts", 'strength: input.strength ?? "strong"', 'strength: input.strength ?? "weak"'), trace: SCENE },
  n1724: { mutation: flip(EXAM, "return exam.items.filter((item) => Date.parse(item.decided_at) > frozen);", "return exam.items.filter((item) => Date.parse(item.decided_at) < frozen);"), trace: SCENE },
  n1725: { mutation: flip(BENCH_COMPARE, "(a.costPerVerified ?? Infinity) - (b.costPerVerified ?? Infinity)", "(b.costPerVerified ?? Infinity) - (a.costPerVerified ?? Infinity)"), trace: SCENE },
  n1726: { mutation: flip("src/rooms/bench/baseline.ts", 'if (state === "ok") recoverable++; else lost.push(sha);', 'if (state !== "ok") recoverable++; else lost.push(sha);'), trace: SCENE },
  n1727: { mutation: distort(MEMORY_COMMAND, '"--seed", String(run.seed),', '"--seed", String(run.seed + 1),'), trace: SCENE },
  n1728: { mutation: distort("src/rooms/memory-eval/server/memory-eval.ts", "precision: delivered.length ? good / delivered.length : 0", "precision: delivered.length ? good / (delivered.length + 1) : 0"), trace: SCENE },
  n1729: { mutation: distort(SELF, "tokensPerAccepted: n ? Math.round(row.tokens / n) : null", "tokensPerAccepted: n ? Math.round(row.tokens / (n + 1)) : null"), trace: SCENE },
  n1730: { mutation: distort(SELF, '"-n", "400", "--name-only"', '"-n", "400", "--name-status"'), trace: SCENE },
  n1731: { mutation: flip("src/rooms/work-graph/logic.ts", 'own[index - 1]?.state !== "running"', 'own[index - 1]?.state === "running"'), reach: entry("the owner opens a task's work graph or the stage statistics"), trace: SCENE },
  n1732: { mutation: distort(SELF, '"<": "&lt;"', '"<": "&gt;"'), trace: SCENE },
} satisfies RegionEvidence;
