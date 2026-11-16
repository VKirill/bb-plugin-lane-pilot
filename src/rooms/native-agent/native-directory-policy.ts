import { BB_BRIDGE_MCP_SERVER } from "./native-session-hooks";

/** Called only for a PM profile when the loaded Core exposes the guarded relocation capability. */
export function allowDirectoryMove(definition: Record<string, unknown>): void {
  if (Array.isArray(definition.disallowedTools)) definition.disallowedTools = definition.disallowedTools.filter((tool) => tool !== `mcp__${BB_BRIDGE_MCP_SERVER}__update_environment_directory`);
  if (typeof definition.prompt === "string") {
    definition.prompt = definition.prompt.replace("Stay in this checkout: this run is bound to it, so `update_environment_directory` and in-place chat moves are disabled.", "This run is bound to its checkout.");
    definition.prompt += "\nFor an explicit request to move THIS chat, use update_environment_directory. Core permits only an idle same-project, same-host move: finish or cancel active, queued, parked and resumable work first. A successful move keeps the old run/history and binds a fresh run; end this turn immediately after success. Do not bypass a refusal with shell or plugin RPC calls.";
  }
}
