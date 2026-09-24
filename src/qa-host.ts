export const QA_HOST_KEY = "browser_qa.host_id";
export const QA_WORKSPACE_KEY = "browser_qa.workspace_path";

export type QaHostOption = { id: string; name: string; status: string; connected: boolean };

export function resolveBrowserQaTarget(args: {
  writerHostId: string;
  configuredHostId: unknown;
  configuredWorkspace: unknown;
  writerWorkspace: string;
}): { hostId: string; workspacePath: string; sameHost: boolean } {
  const hostId = typeof args.configuredHostId === "string" ? args.configuredHostId.trim() : "";
  if (!hostId) throw new Error("browser_qa_host_required");
  const sameHost = hostId === args.writerHostId;
  const workspace = typeof args.configuredWorkspace === "string" ? args.configuredWorkspace.trim() : "";
  if (workspace && !workspace.startsWith("/")) throw new Error("browser_qa_workspace_must_be_absolute");
  if (!sameHost && !workspace) throw new Error("browser_qa_workspace_required_for_cross_host");
  return { hostId, workspacePath: workspace || args.writerWorkspace, sameHost };
}

export const QA_STALE_MS = 60_000;
export const QA_OUTCOME_UNKNOWN = "browser_qa_outcome_unknown";

export function qaCodexPreflight(args: {
  hostId: string;
  providers: Array<{ id: string; available?: boolean }>;
  models: Array<{
    id?: string;
    model?: string;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  }>;
  model?: string;
  reasoning?: string;
}): { ok: true; effort: string } | { ok: false; reason: string } {
  const provider = args.providers.find((row) => row.id === "codex");
  if (!provider?.available) return { ok: false, reason: `browser_qa_provider_unavailable_on_host:${args.hostId}:codex` };
  if (!args.model) return { ok: false, reason: "browser_qa_codex_requires_configured_model" };
  const found = args.models.find((row) => row.id === args.model || row.model === args.model);
  if (!found) return { ok: false, reason: `browser_qa_model_unavailable_on_host:${args.hostId}:codex/${args.model}` };
  const supported = (found.supportedReasoningEfforts ?? []).map((item) => item.reasoningEffort);
  const effort = args.reasoning ?? (typeof found.defaultReasoningEffort === "string" ? found.defaultReasoningEffort : undefined);
  if (!effort) return { ok: false, reason: `browser_qa_effort_required_on_host:${args.hostId}:codex/${args.model}` };
  if (!supported.includes(effort)) {
    return { ok: false, reason: `browser_qa_effort_unavailable_on_host:${args.hostId}:codex/${args.model}/${effort}` };
  }
  return { ok: true, effort };
}

export function qaCodexPreflightReason(args: Parameters<typeof qaCodexPreflight>[0]): string | null {
  const result = qaCodexPreflight(args);
  return result.ok ? null : result.reason;
}

export function qaSpawnClaimed(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { spawnAttempted?: unknown }).spawnAttempted === true);
}

export function resolveStaleBrowserQaReceipt(input: {
  state: string;
  result: unknown;
  updatedAt: number;
  now?: number;
  staleMs?: number;
}):
  | { kind: "terminal" }
  | { kind: "retry" }
  | { kind: "observe" }
  | { kind: "outcome_unknown"; reason: string; result: Record<string, unknown> } {
  if (!["pending", "running"].includes(input.state)) return { kind: "terminal" };
  if (!qaSpawnClaimed(input.result)) return { kind: "retry" };
  const frozen = input.result && typeof input.result === "object" ? { ...(input.result as Record<string, unknown>) } : {};
  const staleMs = input.staleMs ?? QA_STALE_MS;
  const age = (input.now ?? Date.now()) - input.updatedAt;
  if (age < staleMs) return { kind: "observe" };
  const host = typeof frozen.configuredHostId === "string" ? frozen.configuredHostId : "unknown";
  const cwd = typeof frozen.workspacePath === "string" ? frozen.workspacePath : "unknown";
  return {
    kind: "outcome_unknown",
    reason: `${QA_OUTCOME_UNKNOWN}: host RPC has no durable job handle; a runner may have finished on ${host} after the claim. Frozen route host=${host} cwd=${cwd}. No second runner.`,
    result: frozen,
  };
}

export function qaHostUnreachableReason(hostId: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (detail.startsWith("browser_qa_")) return detail;
  return `browser_qa_host_unreachable:${hostId}:${detail}`;
}

export function mapListedQaHosts(listed: unknown): QaHostOption[] {
  if (!Array.isArray(listed)) return [];
  const hosts: QaHostOption[] = [];
  for (const item of listed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : "";
    if (!id) continue;
    const status = typeof rec.status === "string" ? rec.status : "unknown";
    hosts.push({
      id,
      name: typeof rec.name === "string" && rec.name.trim() ? rec.name : id,
      status,
      connected: status === "connected",
    });
  }
  return hosts;
}
