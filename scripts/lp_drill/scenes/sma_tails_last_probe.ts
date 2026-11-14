// Probe of the last tails (scripts/lp_drill/scenes/sma_tails_last.py, run from the tails scene sma_tails.py): runs the REAL code of the checkout for n1230 and n1362 and
// prints one JSON line with what each returned. The observations are the ones tests/sma/four-proofs-tails-last.test.ts asserts (tests/sma/tails-last-world.ts).
// No model, no hub write, nothing outside the machine: a fake plugin host, a scratch database, the project-start graph on the real engine with stubbed helpers.
import { NOTE_STACK, observeMemoryPreview, observeSketch } from "../../../tests/sma/tails-last-world";

async function section<T>(run: () => T | Promise<T>): Promise<T | { error: string }> {
  try { return await run(); } catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) }; }
}

const out = {
  n1230: await section(observeSketch),
  n1362: await section(async () => ({ ...(await observeMemoryPreview()), expected: `- [note] ${NOTE_STACK}` })),
};
console.log(JSON.stringify(out));
