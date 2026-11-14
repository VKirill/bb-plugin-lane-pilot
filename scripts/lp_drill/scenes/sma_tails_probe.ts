// Probe of the tails scene (scripts/lp_drill/scenes/sma_tails.py): runs the REAL code of the checkout for the nodes no region batch owns and prints one JSON line with what
// each returned. The observations are the ones tests/sma/four-proofs-tails.test.ts asserts (tests/sma/tails-world.ts). No model, no hub write, nothing outside the machine.
import { obsBatchPhrase, obsConveyor, obsHardCalls, obsLearnings, obsParity, obsResearch, obsShip, obsSteer, obsUiQa } from "../../../tests/sma/tails-world";

async function section<T>(run: () => T | Promise<T>): Promise<T | { error: string }> {
  try { return await run(); } catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) }; }
}

const out = {
  n480: await section(obsConveyor),
  n557: await section(obsBatchPhrase),
  n564: await section(obsHardCalls),
  n993: await section(obsSteer),
  n1224: await section(obsLearnings),
  n1604: await section(obsUiQa),
  n1675: await section(obsParity),
  n751: await section(obsShip),
  n1615: await section(obsResearch),
};
console.log(JSON.stringify(out)); // guardian: allow (the scene reads this line)
