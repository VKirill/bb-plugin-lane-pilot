import type { WorldApi } from "./service";

/** The RPC handlers of the world room; the contract is in contracts/rpc-world.ts. */
export function worldRpc(world: WorldApi) {
  return {
    world_snapshot: async (input: { withMap?: boolean; projectId?: string }) => ({
      snapshot: JSON.parse(JSON.stringify(world.snapshot(input))) as Record<string, unknown>,
      serverTime: Date.now(),
    }),
    world_events: async (input: { afterSeq: number }) => world.eventsAfter(input.afterSeq),
    world_status: async () => world.status(),
    world_enable: async (input: { enabled: boolean }) => {
      await world.setEnabled(input.enabled);
      return { enabled: input.enabled };
    },
  };
}
