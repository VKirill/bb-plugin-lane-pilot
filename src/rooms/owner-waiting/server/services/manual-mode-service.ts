import { BRAKE_IDS, type ManualMode, type ManualModeState } from "../../../contracts";
import type { BrakeState } from "../../../contracts";
import { createBrakesService, type BrakesDeps } from "./brakes-service";

export interface ManualModeDeps {
  manualMode: ManualMode;
  brakes: BrakesDeps;
  /** The start-up resume the plugin skipped while manual (attempts, graph runs, sweeps); runs when the owner turns manual off. */
  resumeWork?: () => Promise<void>;
}

export type ManualModeView = ManualModeState & { brakes: BrakeState[] };

/** «Ручной режим» over the four brakes: on sets them all, off lifts them all and runs the resume the start skipped. */
export function createManualModeService(deps: ManualModeDeps) {
  const brakes = createBrakesService(deps.brakes);
  const info = (message: string) => deps.brakes.log?.info?.(message);

  async function setAllBrakes(paused: boolean, reason: string): Promise<void> {
    for (const id of BRAKE_IDS) await brakes.set({ id, paused, reason });
  }

  async function get(): Promise<ManualModeView> {
    return { ...deps.manualMode.state(), brakes: (await brakes.get()).brakes };
  }

  async function set(input: { on: boolean; reason?: string }): Promise<ManualModeView> {
    await deps.manualMode.set(input.on, input.reason);
    info(`[manual-mode] set on=${input.on} reason=${input.reason?.trim() || "-"}`);
    await setAllBrakes(input.on, input.reason?.trim() || (input.on ? "manual mode" : "manual mode off"));
    if (!input.on && deps.resumeWork) void deps.resumeWork();
    return get();
  }

  /** At start, before any schedule or trigger runs: a manual plugin holds all four brakes, saved so the board clock reads them. */
  async function holdAtStart(): Promise<void> {
    if (!deps.manualMode.on()) return;
    await setAllBrakes(true, deps.manualMode.state().reason ?? "manual mode");
    info("[manual-mode] start: all brakes on, start-up resume skipped");
  }

  return { get, set, holdAtStart };
}
