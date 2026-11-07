import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CompiledMainAgent } from "./agent-profile";

/** The compiled profile with its role lessons appended, in the same dated-lines block a PM-spawned specialist gets. */
export function withRoleLines(compiled: CompiledMainAgent, lines: readonly string[]): CompiledMainAgent {
  if (!lines.length) return compiled;
  return { ...compiled, prompt: `${compiled.prompt}\n\nLines added to your role in this project (one dated line per review lesson):\n${lines.map((line) => `- ${line}`).join("\n")}` };
}
