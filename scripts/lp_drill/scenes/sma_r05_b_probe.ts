// Probe of scenes/sma_r05_b.py (Region 5 · Daemon life, batch b): runs the REAL code of THIS checkout (the commit under drill) — the settings store, the schedule abort, the
// watchdog script against stand-in tools, the webhook, the phase driver, the digest — and prints what it returned as one JSON line. It judges nothing: the scene compares each
// value with the node card's expected result and prove()s it. No model, no hub write, no network. The observations live in tests/sma/r05-world-b.ts (the test file asserts the same).
// Run with vite-node: the plugin's rooms import each other in cycles that plain tsx cannot link.
import { observeB } from "../../../tests/sma/r05-world-b";

async function main() {
  const wanted = process.argv.slice(2);
  const names = (wanted.length ? wanted : Object.keys(observeB)) as Array<keyof typeof observeB>;
  const seen: Record<string, unknown> = {};
  for (const name of names) {
    try { seen[name] = await (observeB[name] as () => unknown)(); } catch (cause) { seen[name] = { threw: cause instanceof Error ? cause.message : String(cause) }; }
  }
  process.stdout.write(`${JSON.stringify(seen)}\n`);
}
void main();
