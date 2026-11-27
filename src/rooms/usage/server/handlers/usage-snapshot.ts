import type { ManualMode } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { modelCatalogOf } from "../../../platform/server";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { onSettingChanged } from "../../../storage";
import { USAGE_SKIP_KEY } from "../../settings";
import type { ProviderUsage } from "../services/provider-usage";
import { onTokenUsageAdded } from "../services/token-usage-bus";
import { createUsageSnapshotPusher } from "../services/usage-snapshot";

/**
 * The session guard's spend facts (SMA k_hs_spend): pushed on ready, on usage/cap change (`provider/rateLimits/updated`,
 * folded turn tokens, or `usage.skip_percent`), and on host connect (`host:changed`), writing ~/.lane-pilot/usage-snapshot.json
 * with the subscription windows the usage source last measured and whether the spend ceiling is a human's or the default.
 */
export function mountUsageSnapshots(
  ctx: Pick<ServerCore, "bb" | "db"> & Partial<Pick<ServerCore, "isDisposed" | "log">> & { manualMode?: Pick<ManualMode, "on"> },
  providerUsage?: Pick<ProviderUsage, "readings">,
): { push: (targetHostIds?: readonly string[]) => Promise<void> } {
  const { push, forgetHost } = createUsageSnapshotPusher(ctx, providerUsage);

  const unsubSetting = onSettingChanged(ctx.db, (projectId, keys) => {
    if (projectId === GLOBAL_SETTINGS_PROJECT_ID && keys.includes(USAGE_SKIP_KEY)) void push();
  });
  const unsubUsage = onTokenUsageAdded(ctx.bb, () => { void push(); });
  let unsubHost: (() => void) | undefined;
  try {
    const subscribe = (ctx.bb as { sdk?: { subscribe?: (args: { event: "host:changed"; callback: (ev: { id?: string; changes?: readonly string[] }) => void }) => () => void } }).sdk?.subscribe;
    if (typeof subscribe === "function") {
      unsubHost = subscribe({
        event: "host:changed",
        callback: (ev) => {
          if (ctx.isDisposed?.()) return;
          const changes = ev.changes ?? [];
          if (changes.includes("host-disconnected") && ev.id) {
            forgetHost(ev.id);
          }
          if (changes.includes("host-connected")) {
            if (ev.id) forgetHost(ev.id);
            void push(ev.id ? [ev.id] : undefined);
            if (typeof ctx.bb.sdk?.providers?.list === "function") {
              void modelCatalogOf({ bb: ctx.bb, log: ctx.log ?? ((m: string) => ctx.bb.log?.info?.(m)) }).get(true).catch(() => undefined);
            }
          } else if (changes.includes("provider-model-catalog-changed") && typeof ctx.bb.sdk?.providers?.list === "function") {
            void modelCatalogOf({ bb: ctx.bb, log: ctx.log ?? ((m: string) => ctx.bb.log?.info?.(m)) }).get(true).catch(() => undefined);
          }
        },
      });
    }
  } catch { /* test hosts or older cores without realtime subscribe still push on ready and setting/usage changes */ }
  ctx.bb.onDispose?.(() => { unsubSetting(); unsubUsage(); unsubHost?.(); });
  return { push };
}
