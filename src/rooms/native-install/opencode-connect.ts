import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareAndSwapText, readTextState } from "./cas";
import { ensureOpenCodePluginEntry } from "@lane-pilot/kit";
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

async function opencodeVersion(): Promise<string | null> {
  const ran = await spawnAsync("opencode", ["--version"], { timeout: 5000 });
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
      reason: "opencode --version failed; S5 refused to patch",
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
