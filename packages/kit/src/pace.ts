/**
 * A poll or retry pause, shortened by LANE_PILOT_POLL_SCALE when it is set (tests set it so a loop that waits for a fake
 * thread does not sleep its production second). Unset or not a positive number: the pause as written.
 */
export function pollPause(ms: number): number {
  const scale = Number(process.env.LANE_PILOT_POLL_SCALE);
  return scale > 0 ? Math.max(1, Math.round(ms * scale)) : ms;
}
