import { installStack } from "../src/stack-ops";
import type { InstallPhase } from "../src/install-runner";

const phase = process.env.LANE_PILOT_STOP_AFTER as InstallPhase | undefined;
if (!phase || !process.env.HOME || !process.env.LANE_PILOT_FALLBACK) {
  throw new Error("HOME, LANE_PILOT_FALLBACK, LANE_PILOT_STOP_AFTER are required");
}

await installStack({
  requestedHostId: "host_test",
  homeDir: process.env.HOME,
  workspacePath: process.env.HOME,
  confirmExternalOps: false,
  localFallbackPath: process.env.LANE_PILOT_FALLBACK,
  guardSourcePath: process.env.LANE_PILOT_GUARD,
  stopAfterPhase: phase,
  moduleUrl: import.meta.url,
});
