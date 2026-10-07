/** Host calls that write to a git checkout; a reload must not cut one off midway. */
export const CHECKOUT_WRITING_METHODS = new Set(["gitIntegrate", "gitCreateWorktree", "gitRemoveWorktree", "gitPrepareWorktree", "gitCommitDocs",
  "gitRevertPaths", "gitWorktreeSnapshot", "snapshot", "rollback", "install", "applyOnboardingPages", "writeDocsPages"]);

/** Acceptance checks run on the machine as plain calls; a reload kills one midway and the attempt fails with it. */
export const ACCEPTANCE_METHODS = new Set(["runSandboxedCommand"]);

/**
 * A reload stops the host worker mid-call: a git merge killed there left .git/index.lock in SelfyStudio's main and
 * failed every merge for an hour (2026-10-04). Before a deploy the push script turns draining on: calls that write to
 * a checkout wait, the running ones finish, and the reload comes once none is in flight. A drain nobody turned off
 * (the script died) ends by itself after 20 minutes.
 */
export function createDeployDrain(disposed:() => boolean, now = () => Date.now(), pollMs = 2_000) {
  const TTL_MS = 20 * 60_000;
  let on = false, since = 0, next = 0;
  const inFlight = new Map<number, { method:string; startedAt:number }>();
  const draining = () => on && now() - since < TTL_MS;
  return {
    async around<T>(method:string, call:() => Promise<T>):Promise<T> {
      if (!CHECKOUT_WRITING_METHODS.has(method) && !ACCEPTANCE_METHODS.has(method)) return await call();
      while (draining() && !disposed()) await new Promise((wake) => setTimeout(wake, pollMs));
      const token = next++;
      inFlight.set(token, { method, startedAt:now() });
      try { return await call(); } finally { inFlight.delete(token); }
    },
    set(value:boolean) { on = value; since = now(); return this.status(); },
    status() {
      return { draining:draining(), inFlight:[...inFlight.values()].map((call) => ({ method:call.method, ageSec:Math.round((now() - call.startedAt) / 1000) })) };
    },
  };
}

export type DeployDrain = ReturnType<typeof createDeployDrain>;
type DrainTarget = { drain:DeployDrain; log:(line:string) => void };
type DrainContext = { action:string; deadline?:number; signal:AbortSignal; kv:{ set(key:string, value:unknown):Promise<void> } };
export const DRAIN_SNAPSHOT_KEY = "drain:snapshot";

/**
 * The drain of the instance this module belongs to. BB runs `experimental_vkLifecycle` in the module instance that
 * is being replaced, so a module-level binding reaches the right instance; the factory binds it at load.
 */
let drainTarget:DrainTarget | null = null;
export function bindDrainTarget(target:DrainTarget | null):void { drainTarget = target; }

/**
 * VK core drain (`vk.lifecycle.drain` in package.json): before a reload or a server stop, new calls that write to a
 * checkout or run acceptance checks wait, the ones in flight finish, and the plugin's state goes to kv. BB holds new
 * messages, env and tool calls for the new instance meanwhile. Returns once nothing is in flight, at the deadline or
 * on abort; the same switch the `deploy_drain` RPC turns, so the push script's drain stays a working fallback.
 */
export async function drainForLifecycle(ctx:DrainContext, pollMs = 500, now = () => Date.now()):Promise<{ clean:boolean }> {
  const target = drainTarget;
  if (!target) return { clean:true };
  target.drain.set(true);
  const deadline = ctx.deadline ?? now() + 30_000;
  while (target.drain.status().inFlight.length > 0 && now() < deadline && !ctx.signal.aborted) {
    await new Promise((wake) => setTimeout(wake, pollMs));
  }
  const status = target.drain.status();
  const clean = status.inFlight.length === 0;
  await ctx.kv.set(DRAIN_SNAPSHOT_KEY, { action:ctx.action, at:now(), clean, inFlight:status.inFlight }).catch(() => undefined);
  target.log(clean
    ? `Lane Pilot drained for ${ctx.action}: no checkout write or check in flight`
    : `Lane Pilot drain for ${ctx.action} ended with ${status.inFlight.map((call) => `${call.method}(${call.ageSec}s)`).join(", ")} still running`);
  return { clean };
}
