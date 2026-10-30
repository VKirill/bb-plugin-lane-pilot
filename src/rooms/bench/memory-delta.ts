/** Accepted tasks with memory on, minus the same tasks with memory off. A number, not a live drill. */
export function memoryOnOffDelta(onAccepted: number, offAccepted: number): number {
  return onAccepted - offAccepted;
}
