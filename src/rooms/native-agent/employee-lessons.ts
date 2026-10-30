import type { CompiledMainAgent } from "./agent-profile";

/**
 * The role's lessons for a directly called employee. swe/empmem (batch: role memory) owns the real
 * retrieval — project rules filtered to `specialist:<id>`; until it lands this resolves to none.
 * The one seam: anything a specialist chat should carry is appended by `withRoleLines`.
 */
export async function employeeRoleLines(deps: unknown, projectId: string, agentId: string): Promise<string[]> {
  void deps;
  void projectId;
  void agentId;
  return [];
}

/** The compiled profile with its role lessons appended, in the same dated-lines block a PM-spawned specialist gets. */
export function withRoleLines(compiled: CompiledMainAgent, lines: readonly string[]): CompiledMainAgent {
  if (!lines.length) return compiled;
  return { ...compiled, prompt: `${compiled.prompt}\n\nLines added to your role in this project (one dated line per review lesson):\n${lines.map((line) => `- ${line}`).join("\n")}` };
}
