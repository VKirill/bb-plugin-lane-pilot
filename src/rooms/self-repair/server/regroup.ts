import type { ServerCore } from "../../contracts/server";
import type { Incident, SelfRepairConfig, SelfRepairState } from "./types";

const MAX_ALIASES = 500;

export function createRegrouper(_ctx: ServerCore) {
  /**
   * Files an incident under the known group its signature is aliased to (an alias is a signature that was merged into a
   * known problem). Every other signature stays its own group.
   */
  async function regroup(incidents: Incident[], current: SelfRepairState, _cfg: SelfRepairConfig): Promise<number> {
    for (const row of incidents) {
      const alias = current.aliases[row.signature];
      if (alias && current.signatures[alias]) row.signature = alias;
    }
    const entries = Object.entries(current.aliases);
    if (entries.length > MAX_ALIASES) current.aliases = Object.fromEntries(entries.slice(-MAX_ALIASES));
    return 0;
  }

  return regroup;
}
