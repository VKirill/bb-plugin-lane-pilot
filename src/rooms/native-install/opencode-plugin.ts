import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { adaptOpenCodePluginHooks, opencodeNativeToolEnvironment } from "./capabilities";

export const MANAGED_OPENCODE_PLUGIN_MARKER = "/* Lane Pilot managed OpenCode adapter; generated from a capability-compatible source. */";

export function createOpenCodePluginShim(engineRoot: string, adapters: readonly string[] = []): string {
  const entry = pathToFileURL(join(engineRoot, "profiles/opencode/opencode-lane/index.ts")).href;
  const safeRoot = JSON.stringify(engineRoot);
  const safeEntry = JSON.stringify(entry);
  const safeAdapters = JSON.stringify(adapters);
  const environment = adapters.includes("opencode.native_tool_route") ? opencodeNativeToolEnvironment() : {};
  const safeEnvironment = JSON.stringify(environment);
  const adapterFunction = adaptOpenCodePluginHooks.toString();
  return `${MANAGED_OPENCODE_PLUGIN_MARKER}\n` +
    `const laneStackRoot = ${safeRoot};\n` +
    `const lanePluginUrl = ${safeEntry};\n` +
    `const lanePilotAdapters = ${safeAdapters};\n` +
    `const lanePilotEnvironment = ${safeEnvironment};\n` +
    `${adapterFunction};\n` +
    `export default async function lanePilotOpenCodePlugin(context) {\n` +
    `  if (!process.env.LANE_STACK_ROOT) process.env.LANE_STACK_ROOT = laneStackRoot;\n` +
    `  for (const [key, value] of Object.entries(lanePilotEnvironment)) { if (process.env[key] === undefined) process.env[key] = value; }\n` +
    `  const loaded = await import(lanePluginUrl);\n` +
    `  if (typeof loaded.default !== "function") throw new Error("Lane Stack OpenCode plugin has no default function export");\n` +
    `  const hooks = await loaded.default(context);\n` +
    `  return adaptOpenCodePluginHooks(hooks, lanePilotAdapters);\n` +
    `}\n`;
}

export function isManagedOpenCodePlugin(text: string): boolean {
  return text.includes(MANAGED_OPENCODE_PLUGIN_MARKER);
}
