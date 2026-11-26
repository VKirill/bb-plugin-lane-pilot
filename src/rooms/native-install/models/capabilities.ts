// OpenCode v2 contract of Lane Stack's opencode-lane plugin (1.66+): a definition `{ id, setup }` whose setup registers the
// v2 hooks. The v1 hook names (event, chat.message, chat.params, tool.execute.after, messages.transform) and the Cursor ACP
// tool route of v1 lane-session are no longer checked: Lane Pilot's threads run on OpenCode v2 only.
export const REQUIRED_CAPABILITIES = [
  "opencode.plugin.default_export",
  "opencode.hook.event_subscribe",
  "opencode.hook.session_prompt",
  "opencode.hook.session_context",
  "opencode.hook.tool_execute_before",
  "opencode.hook.tool_execute_after",
  "opencode.hook.permission_evaluate",
  "opencode.telemetry.session_compacted",
  "opencode.sticky.contract_recovery",
  "opencode.sticky.dumped_tool_recovery",
  "execution_packet.line_windows",
] as const;

export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];
export type EngineCapability = RequiredCapability | (string & {});

/** What Lane Pilot does itself when the engine lacks it (read-first line windows: tasks/read-first.ts). */
export const ADAPTER_CAPABILITIES = [
  "execution_packet.line_windows",
] as const satisfies readonly RequiredCapability[];

const ADAPTABLE = new Set<string>(ADAPTER_CAPABILITIES);

export const IMPACTED_FUNCTIONS: Record<RequiredCapability, string> = {
  "opencode.plugin.default_export": "OpenCode v2 plugin module loading (a default { id, setup } definition)",
  "opencode.hook.event_subscribe": "OpenCode session lifecycle and compaction event telemetry",
  "opencode.hook.session_prompt": "OpenCode prompt state and sticky task contract",
  "opencode.hook.session_context": "OpenCode sticky task/evidence message recovery",
  "opencode.hook.tool_execute_before": "OpenCode lane writer guard",
  "opencode.hook.tool_execute_after": "OpenCode tool evidence and budget handling",
  "opencode.hook.permission_evaluate": "OpenCode lane agent rules and hub command guard",
  "opencode.telemetry.session_compacted": "OpenCode compacted-session telemetry and recovery",
  "opencode.sticky.contract_recovery": "OpenCode lane contract recovery after compaction",
  "opencode.sticky.dumped_tool_recovery": "OpenCode correction when a provider prints tool JSON instead of calling tools",
  "execution_packet.line_windows": "execution packet read_first line-window selection",
};

export type CapabilityAssessment = {
  compatible: boolean;
  capabilities: string[];
  adaptedCapabilities: RequiredCapability[];
  missingCapabilities: RequiredCapability[];
  diagnostics: Array<{ capability: RequiredCapability; impactedFunction: string; message: string }>;
};

export function assessEngineCapabilities(
  capabilities: Iterable<string>,
  options: { adapters?: Iterable<string> } = {},
): CapabilityAssessment {
  const found = new Set(capabilities);
  const adapters = new Set(options.adapters ?? ADAPTER_CAPABILITIES);
  const adaptedCapabilities: RequiredCapability[] = [];
  const missingCapabilities: RequiredCapability[] = [];

  for (const required of REQUIRED_CAPABILITIES) {
    if (found.has(required)) continue;
    if (ADAPTABLE.has(required) && adapters.has(required)) adaptedCapabilities.push(required);
    else missingCapabilities.push(required);
  }

  return {
    compatible: missingCapabilities.length === 0,
    capabilities: [...found].sort(),
    adaptedCapabilities,
    missingCapabilities,
    diagnostics: missingCapabilities.map((capability) => ({
      capability,
      impactedFunction: IMPACTED_FUNCTIONS[capability],
      message: `Missing required interface ${capability}; impacted function: ${IMPACTED_FUNCTIONS[capability]}.`,
    })),
  };
}
