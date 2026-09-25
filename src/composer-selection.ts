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
  if (environment.kind !== "existing") return false;
  if (environment.type === "reuse") return Boolean(environment.environmentId);
  if (environment.type === "host") return Boolean(environment.hostId && environment.path);
  return false;
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

export function nativeSelectionProjectId(snapshot: ComposerSelectionSnapshot): string | null {
  if (snapshot.status === "ready") return snapshot.projectId;
  if (snapshot.scope.kind === "new-thread") return snapshot.scope.projectId;
  return null;
}
