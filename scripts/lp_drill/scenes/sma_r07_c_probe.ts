// Probe of scenes/sma_r07_c.py (region 7, Providers, models, accounts, batch c: n657 .. n672): runs the REAL code of THIS checkout — the design measuring script on a fake page,
// the writer's launch and brief on a fake plugin host, the Claude launcher script, the fence, the frame summary, the writer chain's park, the usage hold, the rate-limit
// watch and the person's window file — and prints what they returned as one JSON line. It judges nothing: the scene compares each value with the card's expected result and
// prove()s it. No model, no provider, no money, no hub write. The observations are tests/sma/r07-world-c.ts `observe`.
import { observe } from "../../../tests/sma/r07-world-c";

async function main() {
  const seen: Record<string, unknown> = {};
  for (const name of Object.keys(observe) as Array<keyof typeof observe>) {
    try { seen[name] = await (observe[name] as () => unknown)(); } catch (cause) { seen[name] = { threw: cause instanceof Error ? cause.message : String(cause) }; }
  }
  process.stdout.write(`${JSON.stringify(seen)}\n`);
}
void main();
