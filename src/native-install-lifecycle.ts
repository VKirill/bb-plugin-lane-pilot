import type { PluginKvStorage, PluginRpcContract } from "@get-bb/plugin-sdk";
import { hostContract } from "./contracts";
import { drainForLifecycle } from "./server/deploy-drain";

const PREFIX = "native-install:host:";
const ERROR_PREFIX = "native-install:error:";
type Action = "enable" | "disable" | "remove" | "reload" | "shutdown";
type LifecycleContext = {
  action: Action; kv: PluginKvStorage; signal: AbortSignal; deadline?: number;
  callHost(args: { contract: PluginRpcContract; method: string; input: unknown; hostId: string; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
};

export async function registerNativeInstallHost(kv: PluginKvStorage, hostId: string): Promise<void> {
  await kv.set(`${PREFIX}${hostId}`, { hostId });
}

export async function experimental_vkLifecycle(ctx: LifecycleContext): Promise<void> {
  // VK core drain (vk.lifecycle.drain): a reload or server stop lets the running checkout writes and checks finish.
  // Never destructive and never installs; a throw here is only logged by the core.
  if (ctx.action === "reload" || ctx.action === "shutdown") { await drainForLifecycle(ctx); return; }
  for (const key of await ctx.kv.list(PREFIX)) {
    ctx.signal.throwIfAborted();
    const row = await ctx.kv.get<{ hostId: string }>(key);
    if (!row || key !== `${PREFIX}${row.hostId}`) throw new Error("Invalid native installation host registry");
    try {
      await ctx.callHost({ contract: hostContract, method: "nativeInstall", input: { requestedHostId: row.hostId, action: ctx.action }, hostId: row.hostId, signal: ctx.signal, timeoutMs: 600_000 });
      await ctx.kv.delete(`${ERROR_PREFIX}${row.hostId}`);
    } catch (error) {
      // Enable and disable repair Claude Lane on every registered machine. One machine that is offline or has a
      // broken CLI (2026-10-01: Codex on the MacBook) must not take the plugin down everywhere; the error is kept
      // for that host and the next transition retries. Removal stays strict so files are never left orphaned.
      if (ctx.action === "remove") throw error;
      await ctx.kv.set(`${ERROR_PREFIX}${row.hostId}`, { action: ctx.action, error: error instanceof Error ? error.message : String(error), at: Date.now() });
      continue;
    }
    if (ctx.action === "remove") await ctx.kv.delete(key);
  }
}

export function createNativeInstaller(input: {
  supported: boolean; kv: PluginKvStorage;
  call: (hostId: string, action: "install" | "status") => Promise<{ status: string }>;
  log: (message: string) => void;
  waitMs?: number;
}) {
  const pending = new Map<string, Promise<unknown>>();
  const errors = new Map<string, string>();
  async function install(hostId: string) {
    if (!input.supported) throw new Error("Native installation requires BB experimental_vkPluginLifecycle");
    if (pending.has(hostId)) return pending.get(hostId);
    const work = registerNativeInstallHost(input.kv, hostId).then(() => input.call(hostId, "install"));
    pending.set(hostId, work);
    try { const result = await work; errors.delete(hostId); return result; }
    catch (error) { errors.set(hostId, error instanceof Error ? error.message : String(error)); throw error; }
    finally { pending.delete(hostId); }
  }
  /** A dispatch hook must decide within BB's 10 s box, so a send waits for a running install only briefly. */
  const settled = (work: Promise<unknown>) => Promise.race([
    work.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), input.waitMs ?? 5_000)),
  ]);
  const start = (hostId: string) => {
    const work = install(hostId);
    work.catch((error) => input.log(`Native installation failed on ${hostId}: ${error instanceof Error ? error.message : String(error)}`));
    return work;
  };
  return {
    install,
    /** Installs or repairs Claude Lane ahead of the first send, e.g. when Lane Pilot is enabled in the composer. */
    async start(hostId: string) {
      if (!pending.has(hostId)) void start(hostId);
    },
    /** The Maintenance tab's view of one machine: installing, the host's own answer or offline, and the last failure. */
    async status(hostId: string): Promise<{ status: string; error: string | null }> {
      const error = errors.get(hostId) ?? (await input.kv.get<{ error: string }>(`${ERROR_PREFIX}${hostId}`))?.error ?? null;
      if (pending.has(hostId)) return { status: "installing", error };
      try { return { status: (await input.call(hostId, "status")).status, error }; }
      catch { return { status: "offline", error }; }
    },
    async ensure(hostId: string) {
      const running = pending.get(hostId);
      if (running && !await settled(running)) throw new Error("CLI-компоненты Lane Pilot устанавливаются. Повторите отправку после завершения установки.");
      const status = await input.call(hostId, "status");
      if (status.status === "enabled") return;
      const previous = errors.get(hostId);
      if (await settled(start(hostId)) && (await input.call(hostId, "status")).status === "enabled") return;
      const failed = errors.get(hostId);
      if (failed && failed !== previous) throw new Error(`Установка Claude Lane не удалась: ${failed}`);
      throw new Error(previous ? `Повторная установка Lane Pilot начата. Предыдущая ошибка: ${previous}` : "Начата установка CLI-компонентов Lane Pilot. Повторите отправку после завершения установки.");
    },
  };
}
