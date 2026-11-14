// Probe of scenes/sma_r00_c.py (region 0, batch c: execution by plans and the phase's own verification): runs the REAL code of THIS checkout — the phase driver on a
// scratch database and a fake host, the phase logic, the goal audit's inputs — and prints what it returned as one JSON line. It judges nothing: the scene compares each
// value with the card's expected result and prove()s it. No model, no hub write. The observations are tests/sma/r00-world-c.ts `observe`.
import { observe } from "../../../tests/sma/r00-world-c";

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
