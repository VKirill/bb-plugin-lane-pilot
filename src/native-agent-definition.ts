import type { CompiledMainAgent } from "./agent-profile";
import { nativeAgentCliId } from "./native-session";

/** Claude CLI `--agents` AgentDefinition keys from claude-agent-sdk `$e7`. */
export const CLI_AGENT_DEFINITION_FIELDS = [
  "description",
  "prompt",
  "tools",
  "disallowedTools",
  "model",
  "effort",
  "permissionMode",
  "mcpServers",
  "hooks",
  "maxTurns",
  "skills",
  "memory",
] as const;

export const SESSION_RESOURCE_FIELDS = ["tools", "disallowedTools", "skills", "mcpServers"] as const;

const CLI_FIELD_SET = new Set<string>(CLI_AGENT_DEFINITION_FIELDS);

export function assertCliAgentDefinitionFields(fields: Iterable<string>): void {
  const unsupported = [...new Set(fields)].filter((field) => !CLI_FIELD_SET.has(field));
  if (unsupported.length) {
    throw new Error(`unsupported_agent_definition_field:${unsupported.sort().join(",")}`);
  }
}

export function sessionOverrideAgentsJson(input: {
  agentId: string;
  edited: boolean;
  compiled: CompiledMainAgent | null;
  extraFields?: Record<string, unknown>;
}): string | null {
  if (!input.edited) return null;
  if (!input.compiled) throw new Error("edited_profile_missing_compiled");
  const extra = input.extraFields ?? {};
  assertCliAgentDefinitionFields([
    ...SESSION_RESOURCE_FIELDS.filter((field) => input.compiled?.[field] !== undefined),
    ...Object.keys(extra),
  ]);
  const definition: Record<string, unknown> = {
    description: input.compiled.description,
    prompt: input.compiled.prompt,
  };
  for (const field of SESSION_RESOURCE_FIELDS) {
    const value = input.compiled[field];
    if (value !== undefined) definition[field] = value;
  }
  Object.assign(definition, extra);
  return JSON.stringify({ [nativeAgentCliId(input.agentId)]: definition });
}
