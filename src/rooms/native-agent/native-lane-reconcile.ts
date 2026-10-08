import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { atomicText } from "../native-install";

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
 * Brings an existing Claude Lane install to a working state that its own install.sh leaves behind:
 * a Claude plugin cache matching the checkout (same version, newer files), trusted Codex Lane hooks,
 * and the OpenCode Lane plugin also when the user's config is opencode.jsonc.
 */
export async function reconcileClaudeLane(input: { home: string; source: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<LaneReconcileReport> {
  const { home, source, env, signal } = input;
  const report: LaneReconcileReport = { claudePlugin: "fresh", codexHooks: "absent", openCode: "absent" };

  const installedPath = join(home, ".claude/plugins/installed_plugins.json");
  const knownPath = join(home, ".claude/plugins/known_marketplaces.json");
  const installed = JSON.parse(await readFile(installedPath, "utf8").catch(() => "{}")) as { plugins?: Record<string, Array<{ installPath?: string; gitCommitSha?: string }>> };
  const entry = installed.plugins?.["lane-stack@claude-lane-stack"]?.[0];
  const known = JSON.parse(await readFile(knownPath, "utf8").catch(() => "{}")) as Record<string, { installLocation?: string }>;
  const marketplace = known["claude-lane-stack"]?.installLocation;
  if (entry?.installPath && marketplace && await exists(join(marketplace, ".git"))) {
    const head = (await execute("git", ["-C", marketplace, "rev-parse", "HEAD"], { env, signal })).stdout.trim();
    if (head && entry.gitCommitSha !== head) {
      // Claude skips a same-version reinstall; move the stale cache aside so install copies the new files.
      const stale = `${entry.installPath}.stale-${Date.now()}`;
      await rename(entry.installPath, stale).catch(() => undefined);
      try { await execute("claude", ["plugin", "install", "lane-stack@claude-lane-stack", "-s", "user"], { env, signal, timeout: 300_000 }); }
      catch (error) { await rename(stale, entry.installPath).catch(() => undefined); throw error; }
      await rm(stale, { recursive: true, force: true });
      report.claudePlugin = "refreshed";
    }
  }

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
  const profile = join(source, "profiles/opencode");
  const config = await exists(join(openCodeDir, "opencode.jsonc")) ? join(openCodeDir, "opencode.jsonc")
    : await exists(join(openCodeDir, "opencode.json")) ? join(openCodeDir, "opencode.json") : null;
  if (config && await which("opencode", env) && await exists(join(profile, "opencode-lane.ts"))) {
    await mkdir(join(openCodeDir, "plugins/opencode-lane"), { recursive: true });
    await mkdir(join(openCodeDir, "commands"), { recursive: true });
    await mkdir(join(openCodeDir, "agents"), { recursive: true });
    await copyFile(join(profile, "opencode-lane.ts"), join(openCodeDir, "plugins/opencode-lane.ts"));
    for (const name of await readdir(join(profile, "opencode-lane"))) {
      if (name.endsWith(".ts")) await copyFile(join(profile, "opencode-lane", name), join(openCodeDir, "plugins/opencode-lane", name));
    }
    await copyFile(join(profile, "commands/opencode-lane.md"), join(openCodeDir, "commands/opencode-lane.md"));
    for (const name of await readdir(join(profile, "agents")).catch(() => [] as string[])) {
      if (name.endsWith(".md")) await copyFile(join(profile, "agents", name), join(openCodeDir, "agents", name));
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
