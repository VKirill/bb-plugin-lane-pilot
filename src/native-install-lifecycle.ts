import type { PluginKvStorage, PluginRpcContract } from "@get-bb/plugin-sdk";
import { hostContract } from "./contracts";

const PREFIX = "native-install:host:";
type Action = "enable" | "disable" | "remove";
type LifecycleContext = {
  action: Action; kv: PluginKvStorage; signal: AbortSignal;
  callHost(args: { contract: PluginRpcContract; method: string; input: unknown; hostId: string; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
};

export async function registerNativeInstallHost(kv: PluginKvStorage, hostId: string): Promise<void> {
  await kv.set(`${PREFIX}${hostId}`, { hostId });
}

export async function experimental_vkLifecycle(ctx: LifecycleContext): Promise<void> {
  for (const key of await ctx.kv.list(PREFIX)) {
    ctx.signal.throwIfAborted();
    const row = await ctx.kv.get<{ hostId: string }>(key);
    if (!row || key !== `${PREFIX}${row.hostId}`) throw new Error("Invalid native installation host registry");
    await ctx.callHost({ contract: hostContract, method: "nativeInstall", input: { requestedHostId: row.hostId, action: ctx.action }, hostId: row.hostId, signal: ctx.signal, timeoutMs: 600_000 });
    if (ctx.action === "remove") await ctx.kv.delete(key);
  }
}

export function createNativeInstaller(input: {
  supported: boolean; kv: PluginKvStorage;
  call: (hostId: string, action: "install" | "status") => Promise<{ status: string }>;
  log: (message: string) => void;
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
  return {
    install,
    async ensure(hostId: string) {
      if (pending.has(hostId)) throw new Error("CLI-компоненты Lane Pilot устанавливаются. Повторите отправку после завершения установки.");
      const status = await input.call(hostId, "status");
      if (status.status === "enabled") return;
      const previous = errors.get(hostId);
      void install(hostId).catch((error) => input.log(`Native installation failed on ${hostId}: ${error instanceof Error ? error.message : String(error)}`));
      throw new Error(previous ? `Повторная установка Lane Pilot начата. Предыдущая ошибка: ${previous}` : "Начата установка CLI-компонентов Lane Pilot. Повторите отправку после завершения установки.");
    },
  };
}
