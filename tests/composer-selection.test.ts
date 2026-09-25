import { describe, expect, it } from "vitest";
import {
  composerSelectionBlock,
  existingEnvironmentUsable,
  nativeSelectionProjectId,
  nativeSelectionReady,
  useNativeComposerSelection,
  type ComposerSelectionSnapshot,
} from "../src/composer-selection";

const readyReuse: ComposerSelectionSnapshot = {
  status: "ready",
  scope: { kind: "new-thread", projectId: "proj_a" },
  projectId: "proj_a",
  providerId: "openai",
  model: "gpt",
  reasoningLevel: "medium",
  environment: { kind: "existing", type: "reuse", environmentId: "env_1", hostId: "host_1", path: "/tmp/proj" },
};

describe("native composer selection", () => {
  it("treats a missing SDK hook as unsupported without throwing", () => {
    expect(() => useNativeComposerSelection()).not.toThrow();
    const snapshot = useNativeComposerSelection();
    expect(snapshot.status).toBe("unsupported");
    if (snapshot.status === "unsupported") expect(snapshot.reason).toBe("native-selection-unavailable");
    expect(nativeSelectionReady(snapshot)).toBe(false);
  });

  it("is ready only for an existing reuse or host environment with identity", () => {
    expect(nativeSelectionReady(readyReuse)).toBe(true);
    expect(nativeSelectionProjectId(readyReuse)).toBe("proj_a");
    expect(composerSelectionBlock(readyReuse)).toBeNull();
    expect(nativeSelectionReady({ status: "resolving", scope: { kind: "new-thread", projectId: "proj_a" } })).toBe(false);
    expect(composerSelectionBlock({ status: "resolving", scope: { kind: "new-thread", projectId: "proj_a" } })).toBe("resolving");
    expect(existingEnvironmentUsable({ kind: "existing", type: "project-default" })).toBe(false);
    expect(existingEnvironmentUsable({ kind: "provisioning", type: "provider", environmentProviderId: "git-worktree" })).toBe(false);
    expect(existingEnvironmentUsable({ kind: "existing", type: "host", workspaceType: "unmanaged" })).toBe(false);
    expect(existingEnvironmentUsable({ kind: "existing", type: "host", workspaceType: "unmanaged", hostId: "host_1", path: "/tmp/proj" })).toBe(true);
  });
});
