import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { NATIVE_OPENCODE_SOURCES, atomicText } from "../native-install";

const execute = promisify(execFile);
const exists = (path: string) => lstat(path).then(() => true, () => false);
async function which(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return execute("/bin/sh", ["-c", `command -v ${name}`], { env }).then((r) => Boolean(r.stdout.trim()), () => false);
}


export type LaneReconcileReport = { claudePlugin: "fresh" | "refreshed"; codexHooks: "absent" | "trusted" | "newly-trusted"; openCode: "absent" | "registered" | "newly-registered" };

/**
 * Writes Lane Pilot's slim OpenCode plugin from the bundle.
 * Does not clone a checkout, run install.sh, or touch Codex plugin trust. (2026-10-29)
 */
export async function reconcileClaudeLane(input: { home: string; source?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<LaneReconcileReport> {
  const { home, env, signal } = input;
  void signal;
  const report: LaneReconcileReport = { claudePlugin: "fresh", codexHooks: "absent", openCode: "absent" };

  const openCodeDir = join(home, ".config/opencode");
  const config = await exists(join(openCodeDir, "opencode.jsonc")) ? join(openCodeDir, "opencode.jsonc")
    : await exists(join(openCodeDir, "opencode.json")) ? join(openCodeDir, "opencode.json") : null;
  // Modules live in opencode-lane/ beside plugins/; the entry in plugins/ imports one level up.
  // v2 loads every folder under plugins/ as a plugin, so the v1-era plugins/opencode-lane/ goes.
  if (config && await which("opencode2", env)) {
    await rm(join(openCodeDir, "plugins/opencode-lane"), { recursive: true, force: true });
    await mkdir(join(openCodeDir, "opencode-lane"), { recursive: true });
    for (const name of await readdir(join(openCodeDir, "opencode-lane"))) {
      if (name.endsWith(".ts")) await rm(join(openCodeDir, "opencode-lane", name), { force: true });
    }
    for (const [rel, text] of Object.entries(NATIVE_OPENCODE_SOURCES)) {
      const dest = join(openCodeDir, rel === "opencode-lane.ts" ? "plugins/opencode-lane.ts" : rel);
      const body = rel === "opencode-lane.ts" ? text.replaceAll('"./opencode-lane/', '"../opencode-lane/') : text;
      await mkdir(dirname(dest), { recursive: true });
      await atomicText(dest, body);
    }
    const text = await readFile(config, "utf8");
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true }) as { plugin?: unknown } | undefined;
    if (errors.length || !value || typeof value !== "object") throw new Error(`Invalid OpenCode config: ${config}`);
    const plugins = Array.isArray(value.plugin) ? value.plugin as unknown[] : [];
    const entryName = "./plugins/opencode-lane.ts";
    if (plugins.includes(entryName)) report.openCode = "registered";
    else {
      const next = [...plugins.filter((item) => item !== "./plugins/lane-context.ts"), entryName];
      await atomicText(config, applyEdits(text, modify(text, ["plugin"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } })));
      report.openCode = "newly-registered";
    }
  }
  return report;
}
