import type { BbPluginApi, ExperimentalHostCallOptions, ExperimentalHostClient, PluginRpcResult, StandardSchemaV1InferInput } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { z } from "zod";
import type { PrototypeConfig, TaskV2 } from "@lane-pilot/contracts";
import type { OutputGuard } from "@lane-pilot/jev";
import type { LpRealtimeKind } from "@lane-pilot/ui-kit/realtime-channel";
import type { hostContract } from "./host";

/**
 * What `createCore` returns: the composition root's public surface. It lives here so a domain room can name the
 * object it is handed without importing `core`. The member types are the shapes the domains actually see; the
 * owners of the concrete types (relay, secrets, native-agent, …) keep them, and this file only describes them.
 */
export interface ServerCore {
  bb: BbPluginApi;
  db: Database.Database;
  state: { disposed: boolean };
  realtime: Realtime;
  ownerAsk: OwnerAsk;
  secrets: Secrets;
  catalogKey: (name: string) => Promise<string | undefined>;
  forgetCatalogKey: (name: string) => void;
  outputGuard: OutputGuard;
  isDisposed: () => boolean;
  log: (message: string) => void;
  host: ServerHost;
  deployDrain: DeployDrain;
  nativeInstaller: NativeInstaller;
  nativeHost: { call(method: string, input: unknown, options: { hostId: string }): Promise<unknown> };
  serializedKv: <T>(work: () => Promise<T>) => Promise<T>;
  ownedAgents: () => Promise<Record<string, StoredAgentRow>>;
  saveOwnedAgents(owned: Record<string, StoredAgentRow>): Promise<void>;
  knownCustomAgentIds: () => ReadonlySet<string> | null;
  effectiveProjectSettings(projectId: string, scopes?: readonly string[]): Promise<EffectiveProjectSettings>;
  screenWriterBinding(binding: WriterBindingResolution | { status: "catalog_unavailable"; reason: string }): ScreenWriterBinding;
  coexistenceInventory(projectId: string, hostId: string): Promise<HostResult<"coexistenceInventory">>;
  coexistenceOperation(input: CoexistenceOperationInput): Promise<HostResult<"coexistenceOperation">>;
  getThreadBounded(threadId: string, timeoutMs?: number): Promise<unknown>;
  acceptedTaskWorkspace(runId: string, taskId: string, runWorkspacePath: string, contractTask: TaskV2, attemptId?: string): AcceptedTaskWorkspace;
  workspaceExecutionEnvironment(hostId: string, workspace: { path: string; environmentId: string | null }): WorkspaceExecutionEnvironment;
  refreshRun(runId: string): void;
  markCanceledWriterStages(attempt: AttemptRow, reason: string): void;
  cancelQueuedAttempt(attempt: AttemptRow, why?: string, code?: string): { ok: boolean; state: string; reason: string | null };
  isRuntimeSettingKey(key: string): boolean;
  runPolicyFor(runId: string): RunPolicy;
  nativeRunConfig(projectId: string, run: RunRow): Promise<PrototypeConfig | null>;
  sectionRowSchema: z.ZodTypeAny;
  listProjectSections(projectId: string): Promise<SectionRow[]>;
  sectionChain(sections: Array<Pick<SectionRow, "id" | "parentId">>, sectionId: string): string[];
  settingsAbove(projectId: string, scopes: readonly string[]): Record<string, unknown>;
  scopesForWorkspace(projectId: string, workspacePath: string): Promise<string[]>;
  ensureRunScopes(runId: string): Promise<string[]>;
  configForRun(projectId: string, run: RunRow | undefined): Promise<PrototypeConfig | null>;
  writerBindingKey(projectId: string): string;
}

type Realtime = {
  notify(projectId: string, kind: LpRealtimeKind, threadId?: string, id?: string): void;
  dispose(): void;
};

type HostResult<Method extends keyof typeof hostContract & string> = PluginRpcResult<(typeof hostContract)[Method]>;

/**
 * The options the composition root's host wrapper understands beyond the SDK's: `job`/`jobKey` name a background host
 * job, `worktreeOwner` is the worktree registry owner a `gitCreateWorktree` declares (the host never sees any of them).
 */
type HostCallOptions = ExperimentalHostCallOptions & {
  readonly job?: boolean;
  readonly jobKey?: string;
  readonly worktreeOwner?: { readonly kind: string; readonly id: string | null };
};
type ServerHost = Omit<ExperimentalHostClient<typeof hostContract>, "call"> & {
  call: <MethodName extends keyof typeof hostContract & string>(
    method: MethodName,
    input: StandardSchemaV1InferInput<(typeof hostContract)[MethodName]["input"]>,
    options: HostCallOptions,
  ) => Promise<PluginRpcResult<(typeof hostContract)[MethodName]>>;
};

type OwnerChoice = { id: string; label: string } | null;
type OwnerAnswer =
  | { outcome: "answered"; choice: OwnerChoice; text: string; line: string }
  | { outcome: "cancelled"; reason: string }
  | { outcome: "unavailable"; reason: string };
type OwnerAskRequest = {
  source: "pm" | "gate" | "repair" | "council" | "secret";
  question: string;
  detail?: string;
  options?: readonly string[];
  allowText?: boolean;
};
type OwnerAsk = {
  ask(threadId: string, request: OwnerAskRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<OwnerAnswer>;
  askInBackground(
    threadId: string,
    request: OwnerAskRequest,
    onSettled: (answer: OwnerAnswer) => void | Promise<void>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<boolean>;
  answerMessage(question: string, answer: OwnerAnswer, timeoutMs?: number): string;
  sendToThread(threadId: string, text: string): Promise<void>;
  pending(threadId: string): Promise<boolean>;
  recoverLost(): Promise<string[]>;
  available(): boolean;
};

type CredentialKind = "secret" | "ftp" | "ssh" | "login";
type CatalogEntry = { name: string; kind: CredentialKind };
type CatalogRecord = { name: string; kind: CredentialKind; value: string | null; access: Record<string, unknown> | null };
type SecretCheck = { missing: string[]; denied: string[]; wrongKind: string[]; unavailable: boolean };
type SecretResolution = SecretCheck & { env: Record<string, string>; byName: Record<string, Record<string, string>> };
type Secrets = {
  list(options?: { fresh?: boolean }): Promise<CatalogEntry[] | null>;
  record(name: string): Promise<CatalogRecord | null>;
  check(
    input: { declared: readonly string[]; allowed: readonly string[]; kinds?: readonly CredentialKind[] },
    options?: { fresh?: boolean },
  ): Promise<SecretCheck & { catalog: CatalogEntry[] | null }>;
  resolve(input: { declared: readonly string[]; allowed: readonly string[] }): Promise<SecretResolution>;
  save(name: string, value: string, note?: { service?: string; description?: string }): Promise<void>;
};

export type CompiledMainAgent = {
  id: string;
  sourceVersion: string;
  sourceHash: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcpServers?: string[];
};
export type CustomAgentMeta = {
  displayName?: string;
  summary?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  createdAt?: number;
  updatedAt?: number;
  domain?: string;
  machineAffinity?: string;
  deliverables?: string[];
  validator?: string;
  coreSkills?: string[];
  skillSections?: string[];
};
export type StoredAgentRow = {
  prompt?: string;
  description?: string;
  compiled?: CompiledMainAgent;
  compiledCorrupt?: true;
  meta?: CustomAgentMeta;
};

type ProjectSourceBinding = { id?: string; hostId: string; path: string; isDefault?: boolean; projectId?: string };
type WriterBindingResolution =
  | { status: "resolved"; hostId: string; path: string; source: "session" | "unique_source" | "explicit_override"; bindingId?: string }
  | { status: "ambiguous"; bindings: ProjectSourceBinding[] }
  | { status: "setup_required" }
  | { status: "offline"; hostId: string; path: string };
type ScreenWriterBinding = {
  status: WriterBindingResolution["status"] | "catalog_unavailable";
  hostId: string | null;
  path: string | null;
  source: "session" | "unique_source" | "explicit_override" | null;
  bindings: Array<{ id?: string; hostId: string; path: string; isDefault?: boolean }>;
};

type RunPolicy = { schemaVersion: 1; pools: { provider: number; verification: number } };
type EffectiveProjectSettings = { values: Record<string, unknown>; inherited: string[]; explicitKeys: string[] };

type DirtSnapshot = { path: string; sha256: string };
type AttemptRow = {
  id: string;
  run_id: string;
  task_id: string;
  thread_id: string | null;
  holder_thread_id: string | null;
  state: string;
  reason: string | null;
  attempt_no: number;
  dirt_before: DirtSnapshot[];
  workspace_path: string | null;
  environment_id: string | null;
  workspace_decision: unknown | null;
  harness_version: string | null;
};
type RunRow = {
  id: string;
  project_id: string;
  pm_thread_id: string | null;
  state: string;
  kind: string;
  closed_at: number | null;
  writer_workspace_path: string | null;
  writer_environment_id: string | null;
  run_gate: "none" | "pre-merge";
  run_policy_json: string;
};
type SectionRow = {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  path: string;
  hostId: string;
  kind: "folder" | "group";
  paths: Array<{ hostId: string; path: string }>;
};

type DeployDrain = {
  around<T>(method: string, call: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  set(value: boolean): { draining: boolean; inFlight: Array<{ method: string; ageSec: number }> };
  status(): { draining: boolean; inFlight: Array<{ method: string; ageSec: number }> };
};
type NativeInstaller = {
  install(hostId: string): Promise<unknown>;
  forget(hostId: string): Promise<void>;
  start(hostId: string): Promise<void>;
  status(hostId: string): Promise<{ status: string; error: string | null }>;
  ensure(hostId: string): Promise<void>;
};

type CoexistenceOperationInput = {
  projectId: string;
  hostId: string;
  operation: "install" | "connect" | "update" | "reload" | "disconnect" | "rollback";
  manager: "agents-marker" | "managed-checkout" | "claude-cache" | "claude-settings" | "opencode-config" | "opencode-plugin";
  path: string;
  expectedSha256?: string | null;
  snapshotId?: string | null;
  targetSha?: string | null;
};
type AcceptedTaskWorkspace = { task: TaskV2; path: string; environmentId: string | null };
type WorkspaceExecutionEnvironment =
  | { type: "reuse"; environmentId: string }
  | { type: "host"; hostId: string; workspace: { type: "unmanaged"; path: string } };
