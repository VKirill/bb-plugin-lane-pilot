// Probe of scenes/sma_r16_b.py (region 16 batch b, slash commands and workflows): runs the REAL code of THIS checkout (the commit under drill) — the phase gates and
// texts, the phase driver on a scratch database and a fake host, the real workflow engine with fake executors on the real graph files — and prints what
// it returned as one JSON line. It judges nothing: the scene compares each value with the card's expected result and prove()s it. No model, no hub write.
// Each batch of the region adds its observations to tests/sma/r16-world-b.ts and its names here: the list is `observe`'s own keys.
import { observeB as observe } from "../../../tests/sma/r16-world-b";

async function main() {
  const wanted = process.argv.slice(2);
  const names = (wanted.length ? wanted : Object.keys(observe)) as Array<keyof typeof observe>;
  const seen: Record<string, unknown> = {};
  for (const name of names) {
    try { seen[name] = await (observe[name] as () => unknown)(); } catch (cause) { seen[name] = { threw: cause instanceof Error ? cause.message : String(cause) }; }
  }
  process.stdout.write(`${JSON.stringify(seen)}\n`);
}
void main();
