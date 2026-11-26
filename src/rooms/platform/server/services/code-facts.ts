import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import { CODE_FACTS_PROBE, codeFactsState, type CodeFacts } from "../../models/code-facts";

/** The code facts of a checkout on a machine; an unreadable probe reads as none. */
export async function codeFactsOnHost(host: RunCommandHost, hostId: string, cwd: string): Promise<CodeFacts> {
  const probe = await runOnHost(host, { hostId, cwd, command: CODE_FACTS_PROBE, timeoutSec: 30 }).catch(() => null);
  return codeFactsState(probe?.stdout ?? null);
}
