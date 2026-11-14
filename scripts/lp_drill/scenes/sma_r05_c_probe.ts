// Probe of scenes/sma_r05_c.py (Region 5 · Daemon life, batch c): runs the REAL code of THIS checkout (the owner's digest, the calibration, scripts/hub-watchdog.sh and
// scripts/lp-owner-push.sh against stand-in tools) and prints what it returned as one JSON line. It judges nothing: the scene compares each value with the node card's
// expected result and prove()s it. No model, no hub write, no network. The observations live in tests/sma/r05-world-c.ts (the test file asserts the same).
// Run with vite-node: the plugin's rooms import each other in cycles that plain tsx cannot link.
import { observeC, observeC2 } from "../../../tests/sma/r05-world-c";

async function main() {
  const table = { ...observeC, ...observeC2 } as Record<string, () => unknown>;
  const wanted = process.argv.slice(2);
  const seen: Record<string, unknown> = {};
  for (const name of wanted.length ? wanted : Object.keys(table)) {
    try { seen[name] = await table[name]!(); } catch (cause) { seen[name] = { threw: cause instanceof Error ? cause.message : String(cause) }; }
  }
  process.stdout.write(`${JSON.stringify(seen)}\n`);
}
void main();
