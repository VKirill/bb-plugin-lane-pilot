// Probe of scenes/sma_r01_e.py (region 1, batch e): runs the real code of the nodes n288..n319 of THIS checkout on scratch repositories and scratch databases through the same
// observation functions the tests use (tests/sma/r01-world-e.ts, r01-world-e2.ts) and prints what they returned as one JSON line. It judges nothing: the scene compares each value with what
// the node's card expects and prove()s it. No model, no hub write, nothing outside the machine.
import {
  awaitingObs, claimedObs, clarifyConfirmedObs, clarifyNeededObs, clarifyNotNeededObs, completedObs, designConfirmedObs, designGateNeededObs, designGateNotObs, designNeededObs, dryRunObs,
  gateHoldObs, heldObs, queuedObs, reopenObs, wordsObs,
} from "../../../tests/sma/r01-world-e2";
import {
  birthKindsObs, bookCloseObs, contractObs, decisionsObs, harvestObs, holderObs, mergeVerifiedObs, oldPathObs, promiseObs, replaceObs, staleObs, tornObs, unverifiedObs, validateObs,
} from "../../../tests/sma/r01-world-e";

const out: Record<string, unknown> = {};
const step = async (id: string, run: () => unknown | Promise<unknown>) => {
  try { out[id] = await run(); } catch (error) { out[id] = { error: String((error as Error)?.stack ?? error).slice(0, 400) }; }
};

async function main() {
  await step("n288", decisionsObs);
  await step("n289", unverifiedObs);
  await step("n290", holderObs);
  await step("n291", mergeVerifiedObs);
  await step("n292", bookCloseObs);
  await step("n293", oldPathObs);
  await step("n295", harvestObs);
  await step("n296", tornObs);
  await step("n297", replaceObs);
  await step("n298", staleObs);
  await step("n299", birthKindsObs);
  await step("n300", validateObs);
  await step("n301", contractObs);
  await step("n302", promiseObs);
  await step("n303", clarifyNeededObs);
  await step("n304", clarifyConfirmedObs);
  await step("n305", clarifyNotNeededObs);
  await step("n307", dryRunObs);
  await step("n308", designNeededObs);
  await step("n309", designGateNeededObs);
  await step("n310", designConfirmedObs);
  await step("n311", designGateNotObs);
  await step("n312", wordsObs);
  await step("n313", reopenObs);
  await step("n314", gateHoldObs);
  await step("n315", queuedObs);
  await step("n316", heldObs);
  await step("n317", claimedObs);
  await step("n318", awaitingObs);
  await step("n319", completedObs);
  console.log(JSON.stringify(out)); // guardian: allow
}

main().then(() => process.exit(0), (error) => { console.log(JSON.stringify({ fatal: String(error) })); /* guardian: allow */ process.exit(0); });
