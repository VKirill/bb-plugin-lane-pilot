import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MANAGED_OPENCODE_PLUGIN_MARKER = "/* Lane Pilot managed OpenCode adapter; generated from a capability-compatible source. */";

/**
 * The managed `~/.config/opencode/plugins/opencode-lane.ts`: the engine's own OpenCode v2 definition `{ id, setup }`, re-exported.
 * The v1 adapter that wrapped the plugin's hooks is gone: OpenCode v2 loads only a definition object, and the engine (Lane Stack
 * 1.66+) does what the adapter added. LANE_STACK_ROOT tells the engine where its checkout is (it reads it when it runs, not on import).
 */
export function createOpenCodePluginShim(engineRoot: string): string {
  const entry = pathToFileURL(join(engineRoot, "profiles/opencode/opencode-lane/index.ts")).href;
  return `${MANAGED_OPENCODE_PLUGIN_MARKER}\n` +
    `if (!process.env.LANE_STACK_ROOT) process.env.LANE_STACK_ROOT = ${JSON.stringify(engineRoot)};\n` +
    `export { default } from ${JSON.stringify(entry)};\n`;
}

export function isManagedOpenCodePlugin(text: string): boolean {
  return text.includes(MANAGED_OPENCODE_PLUGIN_MARKER);
}
