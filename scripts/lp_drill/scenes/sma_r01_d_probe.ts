// Probe of scenes/sma_r01_d.py (region 1, batch d): runs the real nodes of the verification barrier, the attempt automaton, the landing word and the
// phase's acceptance of THIS checkout on scratch databases and repositories and prints what they returned as one JSON line. It judges nothing: the scene
// compares each value with what the node's card expects and prove()s it. No model, no hub write, nothing outside the machine.
// The observers are the ones the node tests use (tests/sma/r01-world-d.ts, r01-world-d2.ts).
import { verdictSchema } from "../../../packages/workflow-engine/src/verdict";
import {
  observeAuthorized, observeBarrierInput, observeCandidateMerge, observeContract, observeCriticRoute, observeLanded, observeProofGap, observePushRefused, observeRepeat,
} from "../../../tests/sma/r01-world-d";
import { observeClosed, observeIdempotent, observeLines, observePreparedPhase, observeView } from "../../../tests/sma/r01-world-d2";

const out: Record<string, unknown> = {};
const step = async (id: string, run: () => unknown | Promise<unknown>) => {
  try { out[id] = await run(); } catch (error) { out[id] = { error: String((error as Error)?.stack ?? error).slice(0, 400) }; }
};

async function main() {
  await step("n256", () => observeContract());
  await step("n257", () => observeCriticRoute());
  await step("n258", () => observeCandidateMerge());
  await step("n263", () => observeBarrierInput());
  await step("n265", () => {
    const form = { promise: "the promise", correctness: "green", regression: "none", tests: "vitest run", out_of_scope: "docs", floor: "opens", class: "minor" };
    const withForm = verdictSchema.parse({ status: "pass", findings: [], evidence: "read the diff", ...form });
    const plain = verdictSchema.parse({ status: "pass", findings: [], evidence: "read the diff" });
    return { kept: Object.fromEntries(Object.keys(form).map((key) => [key, (withForm as Record<string, unknown>)[key]])), plainKeys: Object.keys(form).filter((key) => key in plain),
      noEvidence: verdictSchema.safeParse({ status: "pass", findings: [] }).success };
  });
  await step("n272", () => observeRepeat());
  await step("n279", () => observeProofGap());
  await step("n280", () => observePushRefused());
  await step("n281", () => observeIdempotent());
  await step("n282", () => observePreparedPhase());
  await step("n283", () => observeAuthorized());
  await step("n284", () => observeLanded());
  await step("n285", () => observeClosed());
  await step("n286", () => observeLines());
  await step("n287", () => observeView());
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().then(() => process.exit(0), (error) => { process.stdout.write(`${JSON.stringify({ fatal: String((error as Error)?.stack ?? error).slice(0, 400) })}\n`); process.exit(0); });
