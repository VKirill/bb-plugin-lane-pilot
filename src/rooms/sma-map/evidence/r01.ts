// Region 1 · Task graph — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. The lines below are the
// framework's worked examples (2026-11-14): each mutation was killed by a real `npm run sma:mutate` run
// (attest/r01.json) and each trace was run on the hub snapshot of the same day.
import { distort, entry, flip, gate, isSet, outside, receipt, rows, transition, type RegionEvidence, via, wrongTarget } from "./types";

export default {
  n169: {
    mutation: wrongTarget("packages/resilience/src/budget.ts", "maxWallMs: now - startedAt, maxTokens: tokens()", "maxWallMs: now - startedAt, maxTokens: children"),
    // The limit does nothing while run.max_tokens is empty — and no hub row sets it: unreachable today, honestly.
    reach: via({ "run.max_tokens": isSet() }),
    trace: transition({ to: "blocked", reason: "run_budget_exceeded" }),
  },
  n175: {
    mutation: flip("src/rooms/contracts/failure-class.ts", "if (cls !== \"task\" && cls !== \"contract\") return null;", "if (cls !== \"task\" || cls !== \"contract\") return null;"),
    trace: transition({ to: "blocked", reason: "repeated_failure:" }),
  },
  n197: {
    mutation: distort("src/rooms/tasks/rails.ts", "/^(M|D|R)/.test(change.status)", "/^(M|R)/.test(change.status)"),
    trace: transition({ to: "blocked", reason: "test_fit" }),
  },
  n202: {
    mutation: distort("src/rooms/contracts/failure-class.ts", "if (MERGE.test(text)) return sure(\"merge\");", "if (MERGE.test(text)) return sure(\"task\");"),
    trace: rows("lane_pilot_attempt", "updated_at", "failure_code IS NOT NULL"),
  },
  n251: {
    mutation: wrongTarget("src/rooms/tasks/rails.ts", "return { approach: line(\"APPROACH\")", "return { approach: line(\"LESSON\")"),
    trace: outside("the markers are read off the writer's answer in finish-attempt-body; only their warnings reach the BB thread"),
  },
  n252: {
    mutation: distort("src/rooms/tasks/rails.ts", "|| \"no reason given\" : null;", "|| \"none\" : null;"),
    trace: outside("a lesson is filed as a writer proposal from the answer text; the plugin database keeps no per-answer marker row"),
  },
  n266: {
    mutation: flip("packages/workflow-engine/src/verdict.ts", "const blocks = hard >= 1 || high > 5;", "const blocks = hard > 1 || high > 5;"),
    trace: gate("accept", ["passed", "rejected"]),
  },
  n267: {
    mutation: flip("packages/workflow-engine/src/verdict.ts", "if (status === \"rework\" && high + critical === 0) status = \"pass\";", "if (status === \"rework\" && high + critical !== 0) status = \"pass\";"),
    trace: receipt("code-critique", "pass"),
  },
  n300: { reach: entry("a PM or the owner enqueues a task contract") },
  n306: {
    mutation: distort("src/rooms/tasks/rails.ts", "held)/.test(code)) return \"dependency\";", "held)/.test(code)) return \"conflict\";"),
    trace: transition({ to: "blocked", reason: "depends_on" }),
  },
  n329: {
    mutation: flip("src/rooms/tasks/rails.ts", "|| a.queuedAt - b.queuedAt);", "|| b.queuedAt - a.queuedAt);"),
    trace: transition({ from: "queued", to: "spawn_requested" }),
  },
} satisfies RegionEvidence;
