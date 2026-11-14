// Probe of scenes/sma_r00_a.py (region 0, Phase graph, batch a: the discussion and the plan admission, n0 … n29): runs the REAL code of THIS checkout (the commit under drill) — the phase
// driver on a scratch database and a fake host, the phase gates and the next-action text, the real workflow engine with fake executors on the real graph files — and prints what
// it returned as one JSON line. It judges nothing: the scene compares each value with the card's expected result and prove()s it. No model, no hub write, nothing outside the machine.
// The observations live in tests/sma/r00-world-a.ts (`observe`); the node tests read the same ones.
import { observe } from "../../../tests/sma/r00-world-a";

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
