// Region 1 · Task graph, batch d (n256-n287): the verification barrier, the attempt automaton, the landing word and the phase's acceptance.
// Kept in its own file so evidence/r01.ts stays under the 500-line limit; r01.ts spreads it in.
import { distort, drill, entry, flip, gate, receipt, rows, transition, type RegionEvidence } from "./types";

export default {
  n256: {
    mutation: distort("packages/contracts/src/schemas.ts", "  acceptance: z.array(z.string().min(1)).min(1),", "  acceptance: z.array(z.string().min(1)).min(0),"),
    trace: drill("sma_r01"),
  },
  n257: {
    mutation: distort("src/rooms/critique/critic-pair.ts", "return offered(peer.providerId, peer.model) ? { pair: peer, changed: true } : { pair: input.critic, changed: false };", "return offered(peer.providerId, peer.model) ? { pair: peer, changed: false } : { pair: input.critic, changed: false };"),
    trace: drill("sma_r01"),
  },
  n258: {
    mutation: distort("src/rooms/verification/git-integrate/merge.ts", "merged.base=before;", "merged.base=sha;"),
    trace: drill("sma_r01"),
  },
  n259: {
    mutation: flip("src/rooms/contracts/failure-class.ts", "if (failureFingerprint(previous.reason) !== failureFingerprint(current.reason)) return null;", "if (failureFingerprint(previous.reason) === failureFingerprint(current.reason)) return null;"),
    trace: [transition({ to: "blocked", reason: "repeated_failure" }), drill("sma_r01")],
  },
  n260: {
    mutation: flip("src/rooms/writer/server/finish-attempt-body.ts", "if (heldHits.length && !holdForOwner) {", "if (heldHits.length && holdForOwner) {"),
    trace: [transition({ to: "blocked", reason: "test_edit_hold" }), drill("sma_r01")],
  },
  n261: {
    mutation: distort("src/rooms/runs/server/stage-records.ts", "attempt:Math.min(input.attempt ?? 0, 2)", "attempt:Math.min(input.attempt ?? 0, 3)"),
    trace: receipt("verification"),
  },
  n262: {
    mutation: distort("src/rooms/verification/sandbox.ts", "maskedSsh,stdout:maskSecrets(child.stdout ?? \"\",secrets)", "maskedSsh,stdout:maskSecrets(child.stdout ?? \"\",secrets).slice(1)"),
    trace: gate("verification", ["passed", "failed"]),
  },
  n263: {
    mutation: distort("src/rooms/writer/server/barrier-input.ts", "priorVerdict: input.priorVerdict ?? null };", "priorVerdict: input.contract ?? null };"),
    trace: drill("sma_r01"),
  },
  n264: {
    mutation: distort("src/rooms/critique/server/critique-runs/attempt-diffs.ts", "return environmentId ? { type:\"reuse\", environmentId } : null;", "return environmentId ? { type:\"reuse\", environmentId:taskId } : null;"),
    trace: [receipt("code-critique", ["passed", "blocked"]), drill("sma_r02")],
  },
  n265: {
    mutation: distort("packages/workflow-engine/src/verdict.ts", "  class: optionalText(80),", "  class: optionalText(4),"),
    trace: drill("sma_r01"),
  },
  n268: {
    mutation: distort("src/rooms/critique/code-critique.ts", "  impact: optionalNote(500),", "  impact: optionalNote(5),"),
    trace: receipt("code-critique", "blocked"),
  },
  n269: {
    mutation: distort("src/rooms/runs/server/stage-records.ts", "summary:input.verdict.summary.slice(0,600)", "summary:input.verdict.summary.slice(0,6)"),
    trace: gate("accept", "rejected"),
  },
  n270: {
    mutation: flip("src/rooms/critique/server/critique-runs/verdict-reasons.ts", "if (result.status !== \"block\") return rework;", "if (result.status === \"block\") return rework;"),
    trace: [transition({ to: "blocked", reason: "verdict_block:code-critique" }), drill("sma_r01")],
  },
  n271: {
    mutation: distort("src/rooms/writer/server/verify.ts", "return { status:\"accepted\", output:outputText(output), produced:checkedPaths,", "return { status:\"accepted\", output:outputText(output), produced:checkedPaths.slice(1),"),
    trace: gate("validate", "passed"),
  },
  n272: {
    mutation: distort("src/rooms/contracts/failure-class.ts", "    .replace(/\\b(lp(attempt|run)|thr|env|term|host|proj|ask)_[a-z0-9]+/g, \"<id>\")", "    .replace(/\\b(lp(attempt|run)|env|term|host|proj|ask)_[a-z0-9]+/g, \"<id>\")"),
    trace: drill("sma_r01"),
  },
  n273: {
    mutation: distort("src/rooms/contracts/state-machine.ts", "{ from:null, event:\"form_task\", to:\"queued\" },", "{ from:null, event:\"form_task\", to:\"spawn_requested\" },"),
    trace: rows("lane_pilot_attempt", "created_at"),
  },
  n274: {
    mutation: distort("src/rooms/contracts/state-machine.ts", "{ from:\"queued\", event:\"spawn_called\", to:\"spawn_requested\" },", "{ from:\"queued\", event:\"spawn_called\", to:\"spawn_unknown\" },"),
    trace: transition({ from: "queued", to: "spawn_requested" }),
  },
  n275: {
    mutation: distort("src/rooms/contracts/state-machine.ts", "{ from:\"spawn_requested\", event:\"spawn_ok\", to:\"running\" },", "{ from:\"spawn_requested\", event:\"spawn_ok\", to:\"queued\" },"),
    trace: transition({ from: "spawn_requested", to: "running" }),
  },
  n276: {
    mutation: distort("src/rooms/contracts/state-machine.ts", "{ from:\"running\", event:\"checks_passed\", to:\"accepted\" },", "{ from:\"running\", event:\"checks_passed\", to:\"blocked\" },"),
    trace: transition({ from: "running", to: "accepted" }),
  },
  n277: {
    mutation: distort("src/rooms/contracts/state-machine.ts", "{ from:\"validation_failed\", event:\"retry_exhausted\", to:\"blocked\" },", "{ from:\"validation_failed\", event:\"retry_exhausted\", to:\"queued\" },"),
    trace: transition({ from: "running", to: ["provider_error", "validation_failed", "empty_output"] }),
  },
  n278: {
    mutation: distort("src/rooms/contracts/state-machine.ts", "{ from:\"cancel_requested\", event:\"cancel_observed\", to:\"canceled\" },", "{ from:\"cancel_requested\", event:\"cancel_observed\", to:\"blocked\" },"),
    trace: transition({ from: "cancel_requested", to: "canceled" }),
  },
  n279: {
    mutation: distort("packages/contracts/src/stage-proof.ts", "\"acceptance_without_code_proof: no stage passed\"", "\"acceptance_without_code_proof: no stage ran\""),
    reach: entry("a writer hands in work and its verification has ended"),
    trace: drill("sma_r01"),
  },
  n280: {
    mutation: distort("src/rooms/native-agent/claude-guard-launch.ts", "\"Bash(git push:*),", "\"Bash(git pull:*),"),
    reach: entry("a writer attempt is launched"),
    trace: drill("sma_r01"),
  },
  n281: {
    mutation: distort("src/rooms/runs/constants.ts", "DISPATCH_IDEMPOTENT_WINDOW_MS = 30 * 60_000;", "DISPATCH_IDEMPOTENT_WINDOW_MS = 1;"),
    trace: drill("sma_r01"),
  },
  n282: {
    mutation: flip("src/rooms/phase/logic/next-action.ts", ".every((line) => line.id === \"result_useful\"", ".some((line) => line.id === \"result_useful\""),
    trace: drill("sma_r01"),
  },
  n283: {
    mutation: flip("src/rooms/tasks/words.ts", "if (latest.decision === \"no\")", "if (latest.decision === \"yes\")"),
    trace: drill("sma_r01"),
  },
  n284: {
    mutation: distort("src/rooms/contracts/state-machine.ts", "to:\"accepted\" as const, why:\"the merge landed", "to:\"blocked\" as const, why:\"the merge landed"),
    trace: drill("sma_r01"),
  },
  n285: {
    mutation: flip("src/rooms/phase/server/driver-steps.ts", "file.sha256 === sha, () => false", "file.sha256 !== sha, () => false"),
    trace: drill("sma_r01"),
  },
  n286: {
    mutation: flip("src/rooms/phase/logic/acceptance.ts", "=> !asked || (word?.decision", "=> asked || (word?.decision"),
    reach: entry("a phase reaches acceptance and the driver reads its lines"),
    trace: drill("sma_r01"),
  },
  n287: {
    mutation: distort("src/rooms/acceptance/card.ts", "isAdvisoryProof(proof) ? \"advisory\" as const : \"code\" as const", "isAdvisoryProof(proof) ? \"code\" as const : \"advisory\" as const"),
    reach: entry("the owner opens a task's acceptance card or a phase's package"),
    trace: drill("sma_r01"),
  },
} satisfies RegionEvidence;
