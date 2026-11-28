import { pluginRootFromModule } from "@lane-pilot/kit";
import type { Room } from "../../contracts";
import { COVERAGE_USAGE, runCoverageCli } from "../cli";
import { listRecentDrills } from "../drills";

/** `pluginRoot` holds `.agents/runs/drills`; the hub's working folder is BB's own, so it cannot be the default. */
export function createCoverageRoom(pluginRoot: string): Room {
  return {
    name: "coverage",
    cli: [{ name:"coverage", summary:"What proves each pipeline stage, attempt transition, failure class, gate, memory path, room and key mechanism: covered live by a deploy-drill scenario, covered by tests only (and why no drill), or not covered; --receipt checks the live claims against a drill receipt", usage:COVERAGE_USAGE, fullHelp: true, run: ({ args }) => runCoverageCli(args) }],
    rpc: () => ({
      drills_list: async ({ limit }: { limit: number }) => ({
        drills: listRecentDrills(pluginRoot, limit),
      }),
    }),
  };
}

export const room: Room = createCoverageRoom(pluginRootFromModule(import.meta.url));
