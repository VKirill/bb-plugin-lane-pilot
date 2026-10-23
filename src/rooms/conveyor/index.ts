// Public API of conveyor: the one switch that holds new work everywhere (no dependencies: every room may read it).
export { CONVEYOR_KEY, conveyorState, setConveyor } from "./logic";
export type { ConveyorState } from "./logic";
