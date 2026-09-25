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
      request?: Record<string, unknown>;
      provenance?: {
        projectId: string;
        sectionId: string | null;
        projectSourceId: string | null;
        hostId: string | null;
        path: string | null;
      };
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
    && Boolean(environment.environmentProviderId)
    && environment.request !== undefined
    && environment.request !== null
    && typeof environment.request === "object";
}

export function nativeSelectionReady(snapshot: ComposerSelectionSnapshot | null): boolean {
  if (!snapshot || snapshot.status !== "ready") return false;
  return existingEnvironmentUsable(snapshot.environment);
}

export function composerSelectionBlock(snapshot: ComposerSelectionSnapshot): ComposerSelectionBlock {
  if (snapshot.status === "resolving") return "resolving";
  if (snapshot.status === "unsupported") return "unsupported";
  if (!existingEnvironmentUsable(snapshot.environment)) return "need_existing_environment";
  return null;
}

export function spawnEnvironmentFromSelection(environment: ComposerEnvironmentSelection): Record<string, unknown> {
  if (environment.kind === "existing" && environment.type === "reuse") {
    return { type: "reuse", environmentId: environment.environmentId };
  }
  if (environment.kind === "existing" && environment.type === "host") {
    if (!environment.hostId) throw new Error("composer_environment_host_missing");
    if (environment.workspaceType === "personal") {
      return { type: "host", hostId: environment.hostId, workspace: { type: "personal" } };
    }
    if (environment.workspaceType === "managed-worktree") {
      return { type: "host", hostId: environment.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } };
    }
    if (!environment.path) throw new Error("composer_environment_path_missing");
    return { type: "host", hostId: environment.hostId, workspace: { type: "unmanaged", path: environment.path } };
  }
  if (environment.kind === "provisioning" && environment.type === "provider") {
    if (!environment.request || typeof environment.request !== "object") {
      throw new Error("composer_environment_request_missing");
    }
    return environment.request;
  }
  throw new Error("composer_environment_not_spawnable");
}

export function readyComposerSnapshot(snapshot: ComposerSelectionSnapshot, projectId: string): Extract<ComposerSelectionSnapshot, { status: "ready" }> {
  if (snapshot.status !== "ready") throw new Error("composer_snapshot_not_ready");
  if (snapshot.projectId !== projectId) throw new Error("composer_snapshot_project_mismatch");
  if (snapshot.scope.kind !== "new-thread") throw new Error("composer_snapshot_scope_unsupported");
  if (snapshot.scope.projectId && snapshot.scope.projectId !== projectId) throw new Error("composer_snapshot_scope_project_mismatch");
  if (!snapshot.providerId || !snapshot.model) throw new Error("composer_snapshot_model_missing");
  if (!existingEnvironmentUsable(snapshot.environment)) throw new Error("composer_environment_not_spawnable");
  return snapshot;
}

export function nativeSelectionProjectId(snapshot: ComposerSelectionSnapshot): string | null {
  if (snapshot.status === "ready") return snapshot.projectId;
  if (snapshot.scope.kind === "new-thread") return snapshot.scope.projectId;
  return null;
}
