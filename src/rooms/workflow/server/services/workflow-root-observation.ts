import type { RunRow } from "../../../storage";
import type { ServerCore } from "../../../contracts/server";
import { gitRepoSnapshot } from "../../../verification/server";
import { chainRuntimeFor, pmCheckout, type Services } from "./workflow-chain-runtime";

/**
 * The `observeRun` engine option for root workflow runs: one measured checkout snapshot per phase, through the same
 * `pmCheckout`/`gitRepoSnapshot` path the read-only helper guard uses. Every failure is an explicit `{snapshot:null, reason}`
 * — the journal row says unmeasured, never clean. Runs without a PM runtime or a resolvable checkout say so.
 */
export function createRootObserver(ctx: ServerCore, services: Services) {
  const runtimeFor = chainRuntimeFor(ctx, services);
  return async ({ run, phase }: { run: RunRow; phase: "before" | "afterExecution" }) => {
    try {
      const rt = runtimeFor(run);
      if (!rt) return { snapshot: null, reason: `no checkout binding for ${phase}: the run has no PM runtime` };
      const checkout = await pmCheckout(rt);
      const snapshot = await gitRepoSnapshot(ctx.host, checkout.hostId, checkout.path);
      return snapshot ? { snapshot, reason: null } : { snapshot: null, reason: `checkout snapshot unavailable for ${phase}` };
    } catch (cause) {
      return { snapshot: null, reason: `observer_error: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
  };
}
