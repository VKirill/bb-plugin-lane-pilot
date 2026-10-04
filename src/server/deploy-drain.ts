/** Host calls that write to a git checkout; a reload must not cut one off midway. */
export const CHECKOUT_WRITING_METHODS = new Set(["gitIntegrate", "gitCreateWorktree", "gitRemoveWorktree", "gitPrepareWorktree", "gitCommitDocs",
  "gitRevertPaths", "gitWorktreeSnapshot", "snapshot", "rollback", "install", "applyOnboardingPages", "writeDocsPages"]);

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
      if (!CHECKOUT_WRITING_METHODS.has(method)) return await call();
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
