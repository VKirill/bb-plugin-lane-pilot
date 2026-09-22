import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Buffer } from "./hash";
import { patchOpenCodePlugin } from "./jsonc";
import { resolveHome } from "./paths";

export type ConnectOpencodeResult = {
  skipped: boolean;
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

const LIMITATION =
  "if the removed plugin[] item is last and a comment precedes it, the comment may visually move after the inserted opencode-lane.ts line; text is preserved";

function opencodeVersion(): string | null {
  try {
    return execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export async function connectOpencode(homeDir?: string): Promise<ConnectOpencodeResult> {
  const home = resolveHome(homeDir);
  const version = opencodeVersion();
  const candidates = [
    join(home, ".config/opencode/opencode.jsonc"),
    join(home, ".config/opencode/opencode.json"),
  ];
  const existing: string[] = [];
  for (const path of candidates) {
    try {
      await readFile(path);
      existing.push(path);
    } catch {
      /* absent */
    }
  }
  if (existing.length === 0) {
    return { skipped: true, reason: "S6: OpenCode config is absent", files: [], version };
  }
  if (!version) {
    return {
      skipped: true,
      reason: "opencode --version failed; S5 refused to patch",
      files: [],
      version: null,
    };
  }
  const files: ConnectOpencodeResult["files"] = [];
  for (const path of existing) {
    const before = await readFile(path, "utf8");
    const shaBefore = sha256Buffer(before);
    const patched = patchOpenCodePlugin(before);
    if (!patched.ok) {
      throw new Error(`OpenCode JSONC refused for ${path}: ${patched.message}`);
    }
    if (patched.changed) await writeFile(path, patched.text);
    const after = patched.text;
    files.push({
      path,
      sha256Before: shaBefore,
      sha256After: sha256Buffer(after),
      changed: patched.changed,
      limitation: LIMITATION,
    });
  }
  return { skipped: false, reason: null, files, version };
}
