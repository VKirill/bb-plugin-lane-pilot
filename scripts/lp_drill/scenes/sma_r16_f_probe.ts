// Probe of scenes/sma_r16_f.py (region 16 batch f, slash commands and workflows): runs the REAL code of THIS checkout (the commit under drill) — the real workflow engine with fake
// executors on the real graph files (lp.analyze, lp.draw, ship, pr-branch and more), the phase driver on a scratch database and a fake host, the PM tool, the phase gates — and
// prints what it returned as one JSON line. It judges nothing: the scene compares each value with the card's expected result and prove()s it. No model, no hub write.
import { observeF as observe } from "../../../tests/sma/r16-world-f";
import { runSim } from "../../../tests/workflow/chain-harness";
import { out, pathOf } from "../../../tests/workflow/chain-helpers";

async function main() {
  const wanted = process.argv.slice(2);
  const names = (wanted.length ? wanted : Object.keys(observe)) as Array<keyof typeof observe>;
  const seen: Record<string, unknown> = {};
  for (const name of names) {
    try {
      const value = await (observe[name] as () => unknown)();
      if (name === "k_c_prbranch") {
        const conflict = await runSim("pr-branch", { input: { phase_id: "ph_a" }, stubs: { split: { branch: "review/ph_a", commits: 1, conflict: true, blocker: { needs: "resolve conflict", from: "owner" }, handoff: "Cherry-pick conflict requires resolution." } } });
        seen[name] = { ...(value as object), conflict: [pathOf(conflict), out(conflict)] };
      } else seen[name] = value;
    } catch (cause) { seen[name] = { threw: cause instanceof Error ? cause.message : String(cause) }; }
  }
  process.stdout.write(`${JSON.stringify(seen)}\n`);
}
void main();
