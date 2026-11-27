import { composeSettingsRegistry, type RoomSettingsPart, type SettingsRegistry } from "@lane-pilot/settings-catalog";
import { backlogSettings } from "./backlog/settings";
import { baselineSettings } from "./baseline/settings";
import { critiqueSettings } from "./critique/settings";
import { docsSettings } from "./docs/settings";
import { errandsSettings } from "./errands/settings";
import { evolveSettings } from "./evolve/settings";
import { leadSettings } from "./lead/settings";
import { memorySettings } from "./memory/settings";
import { moneySettings } from "./money/settings";
import { nativeAgentSettings, nativeAgentKeyFamilies } from "./native-agent/settings";
import { nativeInstallSettings } from "./native-install/settings";
import { ownerWaitingSettings } from "./owner-waiting/settings";
import { platformSettings } from "./platform/settings";
import { qaSettings } from "./qa/settings";
import { relaySettings } from "./relay/settings";
import { reportsSettings } from "./reports/settings";
import { runsSettings } from "./runs/settings";
import { scheduleSettings, scheduleKeyFamilies } from "./schedule/settings";
import { secretsSettings } from "./secrets/settings";
import { sessionHooksSettings } from "./session-hooks/settings";
import { specialistSettings } from "./specialist/settings";
import { stabilitySettings } from "./stability/settings";
import { tasksSettings } from "./tasks/settings";
import { usageSettings } from "./usage/settings";
import { verificationSettings } from "./verification/settings";
import { workflowSettings, workflowKeyFamilies } from "./workflow/settings";
import { writerSettings, writerKeyFamilies } from "./writer/settings";

/**
 * Every surviving room's settings part, composed once into the plugin-wide typed settings registry.
 * UI modules and server validation both import this module (it imports only pure room/settings leaves, never server/ or node:).
 */
export const ROOM_SETTINGS_PARTS: readonly RoomSettingsPart[] = [
  { room: "backlog", settings: backlogSettings },
  { room: "baseline", settings: baselineSettings },
  { room: "critique", settings: critiqueSettings },
  { room: "docs", settings: docsSettings },
  { room: "errands", settings: errandsSettings },
  { room: "evolve", settings: evolveSettings },
  { room: "lead", settings: leadSettings },
  { room: "memory", settings: memorySettings },
  { room: "money", settings: moneySettings },
  { room: "native-agent", settings: nativeAgentSettings, keyFamilies: nativeAgentKeyFamilies },
  { room: "native-install", settings: nativeInstallSettings },
  { room: "owner-waiting", settings: ownerWaitingSettings },
  { room: "platform", settings: platformSettings },
  { room: "qa", settings: qaSettings },
  { room: "relay", settings: relaySettings },
  { room: "reports", settings: reportsSettings },
  { room: "runs", settings: runsSettings },
  { room: "schedule", settings: scheduleSettings, keyFamilies: scheduleKeyFamilies },
  { room: "secrets", settings: secretsSettings },
  { room: "session-hooks", settings: sessionHooksSettings },
  { room: "specialist", settings: specialistSettings },
  { room: "stability", settings: stabilitySettings },
  { room: "tasks", settings: tasksSettings },
  { room: "usage", settings: usageSettings },
  { room: "verification", settings: verificationSettings },
  { room: "workflow", settings: workflowSettings, keyFamilies: workflowKeyFamilies },
  { room: "writer", settings: writerSettings, keyFamilies: writerKeyFamilies },
];

export const SETTINGS_REGISTRY: SettingsRegistry = composeSettingsRegistry(ROOM_SETTINGS_PARTS);
