import { isCodeCriticDefault } from "../../critique";
import type { CodeCriticDefault } from "../../critique";

/**
 * The per-task value of `critic.code.default_for_risk` that a dispatch carries (`dispatchWriter({ criticCodeDefault })`, CLI
 * `dispatch-bb <project> <thread> <task> <baseRef> <off|medium|high>`). The bench sets it per arm to measure the code critic on and off
 * on the same contracts; it wins over the project setting for that task only and is read when the attempt finishes.
 */
type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
const key = (taskId: string) => `critic-code-default:${taskId}`;

export async function saveCriticCodeDefault(kv: Kv, taskId: string, value: CodeCriticDefault | undefined): Promise<void> {
  if (value !== undefined) await kv.set(key(taskId), value as never);
}

export async function loadCriticCodeDefault(kv: Kv, taskId: string): Promise<CodeCriticDefault | undefined> {
  const value = await kv.get(key(taskId)).catch(() => undefined);
  return isCodeCriticDefault(value) ? value : undefined;
}
