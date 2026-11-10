import type { CapabilitiesApi } from "./capability";

export const CAPABILITY_USAGE = "bb lane-pilot capabilities [--probe] [--worker [user]]   (per provider in use: the adapter version and whether it is proven to answer; --probe tries the unproven now; --worker lists the owner's credential paths the worker user can read, a warning and never a failing exit)";
type Result = { exitCode: number; stdout?: string; stderr?: string };

export type WorkerProbe = (user: string) => Promise<{ ok: boolean; reachable: string[] }>;

/** `fromThread`: the caller is an agent thread; it hears the count of exposed paths, never the paths. */
export async function runCapabilityCli(api: CapabilitiesApi, argv: readonly string[], workerProbe?: WorkerProbe, fromThread = false): Promise<Result> {
  try {
    if (argv[0] === "--worker") {
      if (argv.length > 2) return { exitCode: 1, stderr: CAPABILITY_USAGE };
      if (!workerProbe) return { exitCode: 1, stderr: "the worker probe is not mounted" };
      const probe = await workerProbe(argv[1] ?? "lp-worker");
      const body = probe.reachable.length ? (fromThread ? { exposedCount: probe.reachable.length } : { exposed: probe.reachable }) : { closed: true };
      return { exitCode: 0, stdout: JSON.stringify(body, null, 2) };
    }
    if (argv.length > 1 || (argv[0] && argv[0] !== "--probe")) return { exitCode: 1, stderr: CAPABILITY_USAGE };
    const probed = argv[0] === "--probe" ? await api.sweep() : null;
    const table = await api.table();
    return { exitCode: table.some((row) => Object.values(row.capabilities).includes("not_supported")) ? 1 : 0, stdout: JSON.stringify({ ...(probed ? { probed } : {}), table }, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
