import * as pluginApp from "@get-bb/plugin-sdk/app";

export type ComposerSelectionScope =
  | { kind: "new-thread"; projectId: string | null }
  | { kind: "thread"; threadId: string }
  | { kind: "queued-message"; threadId: string }
  | { kind: "side-chat" };

export type ComposerEnvironmentSelection =
  | { kind: "existing"; type: "reuse"; environmentId: string; hostId?: string; path?: string }
  | { kind: "existing"; type: "host"; workspaceType: "personal" | "unmanaged" | "managed-worktree"; hostId?: string; path?: string }
  | { kind: "existing"; type: "project-default" }
  | {
      kind: "provisioning";
      type: "provider";
      environmentProviderId: string;
      machine?: { type: "existing"; hostId: string } | { type: "new"; machineProviderId: string };
    };

export type ComposerEnvironmentRequest = Record<string, unknown> & { type: string };

export type ComposerEnvironmentProvenance = {
  projectId: string;
  sectionId: null;
  projectSourceId?: string;
  hostId?: string;
  path?: string;
};

export type ComposerSelectionSnapshot =
  | { status: "resolving"; scope: Extract<ComposerSelectionScope, { kind: "new-thread" }> }
  | {
      status: "ready";
      scope: Extract<ComposerSelectionScope, { kind: "new-thread" }>;
      projectId: string;
      providerId: string;
      model: string;
      reasoningLevel: string;
      serviceTier?: string;
      environment: ComposerEnvironmentSelection;
      environmentRequest: ComposerEnvironmentRequest;
      environmentProvenance: ComposerEnvironmentProvenance;
    }
  | {
      status: "unsupported";
      scope: ComposerSelectionScope;
      reason: "existing-thread" | "queued-message" | "side-chat" | "native-selection-unavailable";
    };

export type ComposerSelectionBlock =
  | "resolving"
  | "unsupported"
  | "need_existing_environment"
  | null;

function missingHookSnapshot(): ComposerSelectionSnapshot {
  return {
    status: "unsupported",
    scope: { kind: "new-thread", projectId: null },
    reason: "native-selection-unavailable",
  };
}

export function useNativeComposerSelection(): ComposerSelectionSnapshot {
  const hook = (pluginApp as { experimental_useComposerSelection?: () => ComposerSelectionSnapshot })
    .experimental_useComposerSelection;
  if (typeof hook !== "function") return missingHookSnapshot();
  try {
    return hook();
  } catch {
    return missingHookSnapshot();
  }
}

export function existingEnvironmentUsable(environment: ComposerEnvironmentSelection): boolean {
  if (environment.kind === "existing") {
    if (environment.type === "reuse") return Boolean(environment.environmentId);
    if (environment.type === "host") {
      if (environment.workspaceType === "personal") return Boolean(environment.hostId);
      if (environment.workspaceType === "managed-worktree") return Boolean(environment.hostId);
      return Boolean(environment.hostId && environment.path);
    }
    return false;
  }
  return environment.kind === "provisioning"
    && environment.type === "provider"
    && Boolean(environment.environmentProviderId);
}

function isEnvironmentRequest(value: unknown): value is ComposerEnvironmentRequest {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

export function nativeSelectionReady(snapshot: ComposerSelectionSnapshot | null): boolean {
  if (!snapshot || snapshot.status !== "ready") return false;
  if (!existingEnvironmentUsable(snapshot.environment)) return false;
  if (!isEnvironmentRequest(snapshot.environmentRequest)) return false;
  if (!snapshot.environmentProvenance || snapshot.environmentProvenance.projectId !== snapshot.projectId) return false;
  if (snapshot.environment.kind === "provisioning" && snapshot.environmentRequest.type !== "provider") return false;
  return true;
}

export function composerSelectionBlock(snapshot: ComposerSelectionSnapshot): ComposerSelectionBlock {
  if (snapshot.status === "resolving") return "resolving";
  if (snapshot.status === "unsupported") return "unsupported";
  if (!nativeSelectionReady(snapshot)) return "need_existing_environment";
  return null;
}

export function spawnEnvironmentFromSelection(snapshot: Extract<ComposerSelectionSnapshot, { status: "ready" }>): ComposerEnvironmentRequest {
  if (!isEnvironmentRequest(snapshot.environmentRequest)) {
    throw new Error("composer_environment_request_missing");
  }
  return snapshot.environmentRequest;
}

export function readyComposerSnapshot(snapshot: ComposerSelectionSnapshot, projectId: string): Extract<ComposerSelectionSnapshot, { status: "ready" }> {
  if (snapshot.status !== "ready") throw new Error("composer_snapshot_not_ready");
  if (snapshot.projectId !== projectId) throw new Error("composer_snapshot_project_mismatch");
  if (snapshot.scope.kind !== "new-thread") throw new Error("composer_snapshot_scope_unsupported");
  if (snapshot.scope.projectId && snapshot.scope.projectId !== projectId) throw new Error("composer_snapshot_scope_project_mismatch");
  if (!snapshot.providerId || !snapshot.model) throw new Error("composer_snapshot_model_missing");
  if (!nativeSelectionReady(snapshot)) throw new Error("composer_environment_not_spawnable");
  if (snapshot.environmentProvenance.projectId !== projectId) throw new Error("composer_snapshot_provenance_project_mismatch");
  return snapshot;
}

export function nativeSelectionProjectId(snapshot: ComposerSelectionSnapshot): string | null {
  if (snapshot.status === "ready") return snapshot.projectId;
  if (snapshot.scope.kind === "new-thread") return snapshot.scope.projectId;
  return null;
}
