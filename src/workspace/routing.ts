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
