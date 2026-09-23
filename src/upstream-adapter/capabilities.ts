export const REQUIRED_CAPABILITIES = [
  "opencode.plugin.default_export",
  "opencode.hook.event",
  "opencode.hook.chat_message",
  "opencode.hook.chat_params",
  "opencode.hook.tool_execute_after",
  "opencode.hook.messages_transform",
  "opencode.telemetry.session_compacted",
  "opencode.sticky.contract_recovery",
  "opencode.sticky.dumped_tool_recovery",
  "opencode.native_tool_route",
  "execution_packet.line_windows",
] as const;

export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];
export type EngineCapability = RequiredCapability | (string & {});

export const ADAPTER_CAPABILITIES = [
  "opencode.sticky.dumped_tool_recovery",
  "opencode.native_tool_route",
  "execution_packet.line_windows",
] as const satisfies readonly RequiredCapability[];

const ADAPTABLE = new Set<string>(ADAPTER_CAPABILITIES);

export const IMPACTED_FUNCTIONS: Record<RequiredCapability, string> = {
  "opencode.plugin.default_export": "OpenCode plugin module loading",
  "opencode.hook.event": "OpenCode session lifecycle and compaction event handling",
  "opencode.hook.chat_message": "OpenCode prompt routing and sticky task context",
  "opencode.hook.chat_params": "OpenCode model/parameter routing",
  "opencode.hook.tool_execute_after": "OpenCode tool evidence, budget, and winnow result handling",
  "opencode.hook.messages_transform": "OpenCode sticky task/evidence message recovery",
  "opencode.telemetry.session_compacted": "OpenCode compacted-session telemetry and recovery",
  "opencode.sticky.contract_recovery": "OpenCode lane contract recovery after compaction",
  "opencode.sticky.dumped_tool_recovery": "OpenCode correction when a provider prints tool JSON instead of calling tools",
  "opencode.native_tool_route": "OpenCode native read/edit/write/bash tool routing",
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

export type EngineDecision = "reuse" | "install" | "conflict";

export function decideEngine(
  assessment: CapabilityAssessment,
  state: { installed: boolean; modified?: boolean; owner?: "lane-pilot" | "user" | "upstream" | "unknown" },
): { decision: EngineDecision; compatible: boolean; writes: string[]; reason: string | null } {
  if (assessment.compatible && state.installed) {
    return { decision: "reuse", compatible: true, writes: [], reason: null };
  }
  if (state.installed && (state.modified || state.owner === "user" || state.owner === "unknown")) {
    return {
      decision: "conflict",
      compatible: false,
      writes: [],
      reason: assessment.diagnostics[0]?.message ?? "Existing user-owned engine is preserved.",
    };
  }
  return {
    decision: "install",
    compatible: assessment.compatible,
    writes: assessment.compatible ? [] : ["immutable-managed-engine"],
    reason: assessment.diagnostics[0]?.message ?? null,
  };
}

const WINDOW_RE = /L?~?(\d+)\s*[-–—]\s*L?~?(\d+)/gi;
const MAX_WINDOWS = 8;

export type LineWindow = { startLine: number; endLine: number };
export type PathWindows = { path: string; windows: LineWindow[] };

export function parseExecutionLineWindows(raw: string): PathWindows {
  const text = raw.trim();
  if (!text) return { path: "", windows: [] };
  WINDOW_RE.lastIndex = 0;
  const first = WINDOW_RE.exec(text);
  const path = first ? text.slice(0, first.index).trim() : text;
  const tail = text.slice(first?.index ?? text.length);
  const windows: LineWindow[] = [];
  WINDOW_RE.lastIndex = 0;
  for (const match of tail.matchAll(WINDOW_RE)) {
    const startLine = Number(match[1]);
    const endLine = Number(match[2]);
    if (startLine < 1 || endLine < startLine) continue;
    windows.push({ startLine, endLine });
    if (windows.length === MAX_WINDOWS) break;
  }
  return { path: path.replace(/[,:;]+$/, ""), windows };
}

export function opencodeNativeToolEnvironment(): Record<string, string> {
  return {
    CURSOR_ACP_FORWARD_TOOL_CALLS: "false",
    CURSOR_ACP_TOOL_LOOP_MODE: "opencode",
    CURSOR_ACP_MCP_BRIDGE: "false",
  };
}

const DUMPED_TOOL_NAME = /"name"\s*:\s*"(?:bash|shell|read|edit|write|grep|glob|str_replace|Shell|Read|Write|Grep|Glob)"/i;
const DEAD_CURSOR_ROUTE = /Cursor tools.{0,40}unavail|MCP-сервер(?:ы)? не подключен/i;

export function dumpedOpenCodeToolRecovery(text: string): string {
  if (!text || (!DUMPED_TOOL_NAME.test(text) && !DEAD_CURSOR_ROUTE.test(text))) return "";
  return "[opencode-lane tools] JSON-in-chat is ignored. Call OpenCode read/edit/write/bash/grep. Cursor/MCP ACP tools do not exist here. If done or blocked, emit LANE_REPORT now.";
}

export function adaptOpenCodePluginHooks(plugin: unknown, adapters: readonly string[]): unknown {
  if (!plugin || typeof plugin !== "object") return plugin;
  const hooks = { ...(plugin as Record<string, unknown>) };
  if (!adapters.includes("opencode.sticky.dumped_tool_recovery")) return hooks;
  const key = "experimental.chat.messages.transform";
  const original = hooks[key];
  if (typeof original !== "function") return hooks;
  hooks[key] = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const result = await original.apply(this, args);
    const output = args[1] && typeof args[1] === "object" ? args[1] as { messages?: unknown[] } : null;
    const messages = output?.messages;
    if (!messages) return result;
    const texts: string[] = [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const item = message as { info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> };
      if (item.info?.role !== "assistant") continue;
      for (const part of item.parts ?? []) if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
    const body = texts.join("\n");
    const hasToolJson = /"name"\s*:\s*"(?:bash|shell|read|edit|write|grep|glob|str_replace|Shell|Read|Write|Grep|Glob)"/i.test(body)
      || /Cursor tools.{0,40}unavail|MCP-сервер(?:ы)? не подключен/i.test(body);
    const notePrefix = "[opencode-lane tools]";
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const item = message as { parts?: Array<{ synthetic?: boolean; text?: string }> };
      item.parts = (item.parts ?? []).filter((part) => !(part.synthetic && part.text?.startsWith(notePrefix)));
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as { parts?: unknown[] } | undefined;
      if (message && message.parts?.length === 0) messages.splice(index, 1);
    }
    if (hasToolJson) {
      messages.push({
        info: { role: "user" },
        parts: [{
          type: "text",
          text: `${notePrefix} JSON-in-chat is ignored. Call OpenCode read/edit/write/bash/grep. Cursor/MCP ACP tools do not exist here. If done or blocked, emit LANE_REPORT now.`,
          synthetic: true,
        }],
      });
    }
    return result;
  };
  return hooks;
}

const CAPABILITY_MARKERS: Array<{ capability: RequiredCapability; file: string; pattern: RegExp }> = [
  { capability: "opencode.plugin.default_export", file: "profiles/opencode/opencode-lane.ts", pattern: /export\s*\{\s*default\s*\}/ },
  { capability: "opencode.hook.event", file: "profiles/opencode/opencode-lane/index.ts", pattern: /\bevent\s*:\s*async/ },
  { capability: "opencode.hook.chat_message", file: "profiles/opencode/opencode-lane/index.ts", pattern: /["']chat\.message["']\s*:/ },
  { capability: "opencode.hook.chat_params", file: "profiles/opencode/opencode-lane/index.ts", pattern: /["']chat\.params["']\s*:/ },
  { capability: "opencode.hook.tool_execute_after", file: "profiles/opencode/opencode-lane/index.ts", pattern: /["']tool\.execute\.after["']\s*:/ },
  { capability: "opencode.hook.messages_transform", file: "profiles/opencode/opencode-lane/index.ts", pattern: /experimental\.chat\.messages\.transform/ },
  { capability: "opencode.telemetry.session_compacted", file: "profiles/opencode/opencode-lane/telemetry.ts", pattern: /session\.compacted/ },
  { capability: "opencode.sticky.contract_recovery", file: "profiles/opencode/opencode-lane/sticky.ts", pattern: /ensureStickyMessages/ },
  { capability: "opencode.sticky.dumped_tool_recovery", file: "profiles/opencode/opencode-lane/sticky.ts", pattern: /dumpedToolNote/ },
  { capability: "opencode.native_tool_route", file: "bin/lane-session", pattern: /CURSOR_ACP_FORWARD_TOOL_CALLS["']?\s*[:=]/ },
  { capability: "execution_packet.line_windows", file: "bin/execution_packet.py", pattern: /_WINDOW_RE\s*=|line_window/ },
];

export async function inspectEngineCapabilities(root: string): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const found: string[] = [];
  await Promise.all(CAPABILITY_MARKERS.map(async ({ capability, file, pattern }) => {
    try {
      const content = await readFile(join(root, file), "utf8");
      if (pattern.test(content)) found.push(capability);
    } catch {
      // Missing files are reported as missing capabilities by assessEngineCapabilities.
    }
  }));
  return found.sort();
}
