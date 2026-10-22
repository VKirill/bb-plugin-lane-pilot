// Public API of wires: the check of declared wires (pure; the plan-fact stage runs the command on the host).
export { brokenWireReason, readWires, wiresCommand, WIRE_MARK } from "./logic";
export type { Wire, WireHop, WireResult } from "./logic";
