import { execFile, spawn } from "node:child_process";
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


export async function codexRpc(command: string, env: NodeJS.ProcessEnv, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", done = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      child.stdin.end(); child.kill(); error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error("Native installation cancelled"));
    const timer = setTimeout(() => finish(new Error(`Codex ${method} timed out`)), 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => { if (!done) finish(new Error(`Codex app-server exited: ${code}`)); });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 8 * 1024 * 1024) { finish(new Error("Codex response exceeds limit")); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 1 && message.id !== 2) continue;
        if (message.error) { finish(new Error(message.error.message ?? "Codex RPC failed")); return; }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ id: 2, method, params }) + "\n");
        } else finish(null, message.result);
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "lane-pilot-installer", version: "1" }, capabilities: { experimentalApi: true } } }) + "\n");
  });
}

export type LaneReconcileReport = { claudePlugin: "fresh" | "refreshed"; codexHooks: "absent" | "trusted" | "newly-trusted"; openCode: "absent" | "registered" | "newly-registered" };

/**
 * Trusts Codex Lane hooks and writes Lane Pilot's slim OpenCode plugin.
 * `source` is the Claude Lane checkout callers still pass; OpenCode files come from the bundle, not from it.
 * The lane-stack Claude plugin is not installed or refreshed.
 */
export async function reconcileClaudeLane(input: { home: string; source: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<LaneReconcileReport> {
  const { home, source, env, signal } = input;
  void source;
  const report: LaneReconcileReport = { claudePlugin: "fresh", codexHooks: "absent", openCode: "absent" };

  if (await which("codex", env) && await exists(join(home, ".codex/config.toml"))) {
    const inventory = await codexRpc("codex", env, "hooks/list", { cwds: [home] }, signal) as { data: Array<{ hooks: Array<{ pluginId: string; key: string; currentHash: string; trustStatus?: string }> }> };
    const hooks = inventory.data.flatMap((row) => row.hooks).filter((hook) => hook.pluginId === "codex-lane@claude-lane-stack");
    if (hooks.length) {
      const untrusted = hooks.filter((hook) => hook.trustStatus !== "trusted");
      report.codexHooks = untrusted.length ? "newly-trusted" : "trusted";
      if (untrusted.length) {
        const path = join(home, ".codex/config.toml");
        let text = await readFile(path, "utf8");
        for (const hook of untrusted) {
          const header = `[hooks.state.${JSON.stringify(hook.key)}]`;
          const block = `${header}\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`;
          const at = text.indexOf(header);
          if (at < 0) text = `${text}${text.endsWith("\n") ? "" : "\n"}\n${block}`;
          else {
            const next = text.indexOf("\n[", at + header.length);
            text = text.slice(0, at) + block + (next < 0 ? "" : text.slice(next + 1));
          }
        }
        await atomicText(path, text);
      }
    }
  }

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
