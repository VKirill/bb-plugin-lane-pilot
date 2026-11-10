import type { CapabilitiesApi } from "./capability";

export const CAPABILITY_USAGE = "bb lane-pilot capabilities [--probe] [--worker]   (per provider in use: the adapter version and whether it is proven to answer; --probe tries the unproven now; --worker checks the worker user cannot reach the owner's secrets)";
type Result = { exitCode: number; stdout?: string; stderr?: string };

export async function runCapabilityCli(api: CapabilitiesApi, argv: readonly string[], workerProbe?: () => Promise<{ ok: boolean; reachable: string[] }>): Promise<Result> {
  try {
    if (argv.length > 1 || (argv[0] && argv[0] !== "--probe" && argv[0] !== "--worker")) return { exitCode: 1, stderr: CAPABILITY_USAGE };
    if (argv[0] === "--worker") {
      const probe = workerProbe ? await workerProbe() : null;
      return probe ? { exitCode: probe.ok ? 0 : 1, stdout: JSON.stringify(probe.reachable.length ? { exposed: probe.reachable } : { closed: true }, null, 2) } : { exitCode: 1, stderr: "the worker probe is not mounted" };
    }
    const probed = argv[0] === "--probe" ? await api.sweep() : null;
    const table = await api.table();
    return { exitCode: table.some((row) => Object.values(row.capabilities).includes("not_supported")) ? 1 : 0, stdout: JSON.stringify({ ...(probed ? { probed } : {}), table }, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
