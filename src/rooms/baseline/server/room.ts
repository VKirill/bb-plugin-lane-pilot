import type { Room } from "../../contracts";
import type { BaselineApi } from "./services/baseline-service";
import { BASELINE_USAGE, runBaselineCli } from "./handlers/baseline-cli";
import { baselineSettings } from "../settings";

export const room: Room<{ baseline: BaselineApi }> = {
  name: "baseline",
  settings: baselineSettings,
  cli: [
    { name:"baseline", summary:"The checks already green or red on the base a task started from, and what turned red after its merge", usage:BASELINE_USAGE, run: ({ services, args }) => runBaselineCli(services, args) },
  ],
};
