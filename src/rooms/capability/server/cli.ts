import type { CapabilitiesApi } from "./capability";

export const CAPABILITY_USAGE = "bb lane-pilot capabilities [--probe]   (per provider in use: the adapter version and whether it is proven to answer; --probe tries the unproven now)";
type Result = { exitCode: number; stdout?: string; stderr?: string };

export async function runCapabilityCli(api: CapabilitiesApi, argv: readonly string[]): Promise<Result> {
  try {
    if (argv.length > 1 || (argv[0] && argv[0] !== "--probe")) return { exitCode: 1, stderr: CAPABILITY_USAGE };
    const probed = argv[0] === "--probe" ? await api.sweep() : null;
    const table = await api.table();
    return { exitCode: table.some((row) => Object.values(row.capabilities).includes("not_supported")) ? 1 : 0, stdout: JSON.stringify({ ...(probed ? { probed } : {}), table }, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
