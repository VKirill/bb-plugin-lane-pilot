import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../../contracts";
import type { BenchApi } from "../service";

/** The bench over RPC, read side: sets with their series, and the paired comparison of two arms. Running and building go through the CLI. */
export function benchRpc(bench: BenchApi) {
  return {
    bench_status: async ({ version }) => ({ sets: bench.status(version), settings: await bench.settings() }),
    bench_compare: async ({ version, armA, armB, noise }) => {
      const result = bench.compare({ version, armA, armB, ...(noise ? { noiseArms: noise } : {}) });
      return { comparison: result.comparison, text: result.text };
    },
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "bench_status" | "bench_compare">;
}
