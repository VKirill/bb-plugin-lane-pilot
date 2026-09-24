export type WorkspaceMode = "in_place" | "worktree" | "auto";
export type AttemptWorkspaceStrategy = "inherit_run" | "provision_attempt_worktree";

export type AttemptWorkspaceDecision = {
  schemaVersion:1;
  mode:WorkspaceMode;
  taskRisk:string;
  score:number;
  minScore:number;
  multiWrite:boolean;
  multiWriteEnabled:boolean;
  strategy:AttemptWorkspaceStrategy;
  reason:"explicit_in_place"|"explicit_worktree"|"risk_threshold"|"multi_write"|"below_threshold";
};

export function parseWorkspaceMode(value: unknown): WorkspaceMode {
  if (value === undefined || value === null || value === "") return "auto";
  if (value === "in_place" || value === "worktree" || value === "auto") return value;
  throw new Error(`workspace.mode must be in_place, worktree, or auto; received ${String(value)}`);
}

export function usesManagedWorktree(mode: WorkspaceMode): boolean {
  // Auto must stay on the configured base workspace until task-v2 risk and
  // expected outputs are known; spawnWriterAttempt applies the per-attempt policy.
  return mode === "worktree";
}

export function resolveAttemptWorkspace(input:{mode:WorkspaceMode;risk:unknown;expectedOutputCount:number;minScore:number;multiWriteEnabled:boolean}):AttemptWorkspaceDecision {
  if (!Number.isInteger(input.minScore)||input.minScore<0||input.minScore>10) throw new Error("workspace.worktree_min_score must be an integer from 0 to 10");
  if (!Number.isInteger(input.expectedOutputCount)||input.expectedOutputCount<0) throw new Error("expected output count must be a non-negative integer");
  const risk=typeof input.risk==="string"?input.risk:"";
  const score=({low:2,medium:5,high:8,critical:10} as Record<string,number>)[risk];
  if(score===undefined) throw new Error(`unsupported task risk for workspace routing: ${risk||"missing"}`);
  const multiWrite=input.expectedOutputCount>1;
  if(input.mode==="in_place") return {schemaVersion:1,mode:input.mode,taskRisk:risk,score,minScore:input.minScore,multiWrite,multiWriteEnabled:input.multiWriteEnabled,strategy:"inherit_run",reason:"explicit_in_place"};
  if(input.mode==="worktree") return {schemaVersion:1,mode:input.mode,taskRisk:risk,score,minScore:input.minScore,multiWrite,multiWriteEnabled:input.multiWriteEnabled,strategy:"inherit_run",reason:"explicit_worktree"};
  if(score>=input.minScore) return {schemaVersion:1,mode:input.mode,taskRisk:risk,score,minScore:input.minScore,multiWrite,multiWriteEnabled:input.multiWriteEnabled,strategy:"provision_attempt_worktree",reason:"risk_threshold"};
  if(multiWrite&&input.multiWriteEnabled) return {schemaVersion:1,mode:input.mode,taskRisk:risk,score,minScore:input.minScore,multiWrite,multiWriteEnabled:input.multiWriteEnabled,strategy:"provision_attempt_worktree",reason:"multi_write"};
  return {schemaVersion:1,mode:input.mode,taskRisk:risk,score,minScore:input.minScore,multiWrite,multiWriteEnabled:input.multiWriteEnabled,strategy:"inherit_run",reason:"below_threshold"};
}

export function requireManagedWorktreeProvider(providers: unknown): { id: string } {
  if (!Array.isArray(providers)) throw new Error("attempt_worktree_provider_unavailable:listProviders");
  const found = providers.find((row) => {
    if (!row || typeof row !== "object") return false;
    const rec = row as Record<string, unknown>;
    return rec.id === "git-worktree" || rec.pluginId === "environment-git-worktree";
  }) as Record<string, unknown> | undefined;
  if (!found || typeof found.id !== "string" || !found.id) throw new Error("attempt_worktree_provider_unavailable");
  const availability = found.availability;
  if (availability && typeof availability === "object") {
    const status = (availability as Record<string, unknown>).status;
    if (status === "unavailable") {
      const message = (availability as Record<string, unknown>).message;
      throw new Error(`attempt_worktree_provider_unavailable:${typeof message === "string" && message ? message : "unavailable"}`);
    }
  }
  return { id: found.id };
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const got = Reflect.get(value, key);
  return typeof got === "string" && got ? got : null;
}

export function classifyManagedWorkspace(
  environment: unknown,
  expectedHostId: string,
): {kind:"ready";workspace:{environmentId:string;hostId:string;path:string}} | {kind:"pending";status:string} | {kind:"failed";reason:string} {
  if (!environment || typeof environment !== "object") return {kind:"pending",status:"missing"};
  const status = stringField(environment, "status") ?? "unknown";
  if (status === "failed" || status === "destroyed" || status === "error") return {kind:"failed",reason:status};
  if (status !== "ready") return {kind:"pending",status};
  try {
    return {kind:"ready",workspace:resolveManagedWorkspace(environment, expectedHostId)};
  } catch (cause) {
    return {kind:"failed",reason:cause instanceof Error ? cause.message : String(cause)};
  }
}

export async function waitManagedWorktreeReady(input:{
  threadId:string;
  expectedHostId:string;
  spawnEnvironmentId?:string|null;
  getThread:(threadId:string)=>Promise<unknown>;
  getEnvironment:(environmentId:string)=>Promise<unknown>;
  now?:()=>number;
  sleep?:(ms:number)=>Promise<void>;
  timeoutMs?:number;
  intervalMs?:number;
}): Promise<{environmentId:string}> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  const intervalMs = input.intervalMs ?? 500;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let environmentId = input.spawnEnvironmentId && input.spawnEnvironmentId.trim() ? input.spawnEnvironmentId.trim() : "";
  let lastStatus = environmentId ? "bound" : "unbound";
  while (now() < deadline) {
    const thread = await input.getThread(input.threadId);
    environmentId = stringField(thread, "environmentId") ?? environmentId;
    if (environmentId) {
      const classified = classifyManagedWorkspace(await input.getEnvironment(environmentId), input.expectedHostId);
      if (classified.kind === "ready") return {environmentId:classified.workspace.environmentId};
      if (classified.kind === "failed") throw new Error(`attempt_worktree_provision_failed:${classified.reason}`);
      lastStatus = classified.status;
    } else {
      lastStatus = "missing_environment_id";
    }
    if (now() >= deadline) break;
    await sleep(intervalMs);
  }
  throw new Error(`attempt_worktree_provision_timeout:${lastStatus}`);
}

export function resolveManagedWorkspace(
  environment: unknown,
  expectedHostId: string,
): { environmentId: string; hostId: string; path: string } {
  if (!environment || typeof environment !== "object") throw new Error("managed workspace lookup returned no environment");
  const row = environment as Record<string, unknown>;
  if (row.status !== "ready") throw new Error(`managed workspace is not ready (status=${String(row.status)})`);
  if (row.hostId !== expectedHostId) throw new Error(`managed workspace host mismatch (${String(row.hostId)})`);
  if (row.managed !== true || row.workspaceProvisionType !== "managed-worktree") {
    throw new Error("environment is not a managed worktree");
  }
  if (typeof row.id !== "string" || row.id.length === 0) throw new Error("managed workspace has no environment id");
  if (typeof row.path !== "string" || !row.path.startsWith("/")) throw new Error("managed workspace has no absolute path");
  return { environmentId: row.id, hostId: row.hostId, path: row.path };
}
