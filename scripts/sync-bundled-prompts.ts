/**
 * Writes the BB session prompt of every bundled agent (src/native-agent-overlay.ts) into src/bundled-agents.json, so the copy the
 * handoff registry and the stock-stub check read cannot drift from the live overlay. `tests/pm-instructions.test.ts` fails when it does.
 * Run after changing a session prompt or after `bundle-lane-agents.py`: node_modules/.bin/tsx scripts/sync-bundled-prompts.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { laneSessionOverlayPrompt } from "../src/native-agent-overlay";

const file = new URL("../src/bundled-agents.json", import.meta.url);
const bundled = JSON.parse(readFileSync(file, "utf8")) as Record<string, { prompt: string }>;
let changed = 0;
for (const [id, agent] of Object.entries(bundled)) {
  const overlay = laneSessionOverlayPrompt(id);
  if (!overlay || agent.prompt === overlay) continue;
  agent.prompt = overlay;
  changed += 1;
}
if (changed) writeFileSync(file, `${JSON.stringify(bundled, null, 2)}\n`);
console.log(`${changed} bundled prompt(s) updated`);
