import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { roleLinesKey } from "../critique/server";
import type { CompiledMainAgent } from "./agent-profile";

/**
 * The role's lessons for a directly called employee: the same `lp.role.lines:<project>:<role>` list the
 * `lp.specialist_brief` step renders (written by employee.remark / recordEmployeeLesson), so a chat the owner
 * opens with an employee carries the same rules a PM-delegated run does.
 */
export async function employeeRoleLines(bb: Pick<BbPluginApi, "storage">, projectId: string, agentId: string): Promise<string[]> {
  return ((await bb.storage.kv.get(roleLinesKey(projectId, agentId)).catch(() => null)) as string[] | null) ?? [];
}

/** The compiled profile with its role lessons appended, in the same dated-lines block a PM-spawned specialist gets. */
export function withRoleLines(compiled: CompiledMainAgent, lines: readonly string[]): CompiledMainAgent {
  if (!lines.length) return compiled;
  return { ...compiled, prompt: `${compiled.prompt}\n\nLines added to your role in this project (one dated line per review lesson):\n${lines.map((line) => `- ${line}`).join("\n")}` };
}
