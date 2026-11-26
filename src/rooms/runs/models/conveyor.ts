/**
 * The conveyor switch (SMA atlas D2-10: «Conveyor switch», «Conveyor off from the factory»): one flag for the whole plugin. Off, no new
 * work is issued anywhere — a task waits before it takes a writer slot exactly as in a paused run (`isHeld`, runs/server/services/runs-pause.ts), parked tasks are not restarted, the
 * night loop picks nothing — while running attempts finish their current stage and every check (run goal, capabilities, regression) goes
 * on. The flag lives in the plugin's key-value store, so a reload keeps it.
 */
export const CONVEYOR_KEY = "conveyor:off";
export type ConveyorState = { on: boolean; since: string | null; reason: string | null };

/** The one line the start says while the conveyor is off, with the way out of it (SMA m_say_pipeline); null while it is on. */
export function conveyorStartLine(state: ConveyorState): string | null {
  return state.on ? null : `Lane Pilot: the conveyor is OFF since ${state.since}${state.reason ? ` (${state.reason})` : ""}: no new work is issued. Turn it on with: bb lane-pilot conveyor on`;
}
