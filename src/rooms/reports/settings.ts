import { DEFAULT_LOOP_MODES } from "@lane-pilot/contracts";
import { SETTING_LOOPS_MODE, defineSetting, type SettingDefinition } from "@lane-pilot/settings-catalog";

export const LOOPS_MODE_KEY = SETTING_LOOPS_MODE;

export const reportsSettings: readonly SettingDefinition[] = [
  defineSetting({
    key: LOOPS_MODE_KEY,
    room: "reports",
    default: DEFAULT_LOOP_MODES,
    defaultValue: JSON.stringify(DEFAULT_LOOP_MODES),
    bounds: { kind: "json" },
    ui: {
      status: "hidden",
      control: "input",
      section: "improvement",
      scope: "global",
      reason: "Per-loop operating mode (on, report, off) for discovery, branches, evolve, employee, templates",
    },
  }),
];
