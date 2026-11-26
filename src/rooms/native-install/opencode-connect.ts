import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compareAndSwapText, readTextState } from "./cas";
import { ensureOpenCodePluginEntry } from "./models/opencode-jsonc";
import { resolveHome } from "@lane-pilot/kit";
import { spawnAsync } from "@lane-pilot/kit";

export type ConnectOpencodeResult = {
  skipped: boolean;
  conflict: boolean;
  reason: string | null;
  files: Array<{
    path: string;
    sha256Before: string | null;
    sha256After: string | null;
    changed: boolean;
    limitation: string | null;
  }>;
  version: string | null;
};

/** OpenCode v2 (`opencode2`): Lane Pilot's threads run only on it; v1's `opencode` is not a target. */
async function opencodeVersion(): Promise<string | null> {
  const ran = await spawnAsync("opencode2", ["--version"], { timeout: 5000 });
  return ran.error || ran.status !== 0 ? null : ran.stdout.trim();
}

export async function connectOpencode(homeDir?: string): Promise<ConnectOpencodeResult> {
  const home = resolveHome(homeDir);
  const version = await opencodeVersion();
  const candidates = [
    join(home, ".config/opencode/opencode.jsonc"),
    join(home, ".config/opencode/opencode.json"),
  ];
  const existing: string[] = [];
  for (const path of candidates) {
    try {
      await readFile(path);
      existing.push(path);
      break;
    } catch {
      /* absent */
    }
  }
  if (existing.length === 0) {
    return { skipped: true, conflict: false, reason: "S6: OpenCode config is absent", files: [], version };
  }
  if (!version) {
    return {
      skipped: true,
      conflict: false,
      reason: "opencode2 --version failed; S5 refused to patch",
      files: [],
      version: null,
    };
  }
  const files: ConnectOpencodeResult["files"] = [];
  for (const path of existing) {
    const state = await readTextState(path);
    if (state.text === null) {
      return { skipped: true, conflict: true, reason: `CAS conflict: ${path} is not a regular readable config file`, files, version };
    }
    const patched = ensureOpenCodePluginEntry(state.text);
    if (!patched.ok) {
      throw new Error(`OpenCode JSONC refused for ${path}: ${patched.message}`);
    }
    const write = await compareAndSwapText(path, state.sha256, patched.text);
    if (write.status === "conflict") {
      return { skipped: true, conflict: true, reason: write.reason, files, version };
    }
    if (write.status !== "ok") {
      return { skipped: true, conflict: true, reason: write.reason ?? `CAS write failed for ${path}`, files, version };
    }
    files.push({
      path,
      sha256Before: write.beforeSha256,
      sha256After: write.afterSha256,
      changed: write.changed,
      limitation: null,
    });
  }
  return { skipped: false, conflict: false, reason: null, files, version };
}

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
