import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CompiledMainAgent } from "./agent-profile";

/** The KV key of the role's lesson lines, shared by every reader (specialist brief, employee chat, PM tools). */
export const roleLinesKey = (projectId: string, role: string) => `lp.role.lines:${projectId}:${role}`;

/** A dated rule line on `lp.role.lines:<projectId>:<role>` — what the specialist's brief prepends. */
export async function recordRoleLine(kv: BbPluginApi["storage"]["kv"], projectId: string, role: string, line: string): Promise<string> {
  const dated = /^\d{4}-\d{2}-\d{2}:/.test(line) ? line.trim().slice(0, 500) : `${new Date().toISOString().slice(0, 10)}: ${line.trim().slice(0, 500)}`;
  const key = roleLinesKey(projectId, role);
  const lines = ((await kv.get(key).catch(() => null)) as string[] | null) ?? [];
  if (!lines.includes(dated)) await kv.set(key, [...lines, dated].slice(-30) as never);
  return dated;
}

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
