import type { LoopMode, LoopName } from "@lane-pilot/contracts";

export type LoopHealthEntry = {
  loop: LoopName;
  mode: LoopMode;
  metric: number | null;
  threshold: number;
  failing: boolean;
  evidence: Record<string, unknown>;
};
