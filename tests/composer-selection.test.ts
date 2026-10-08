import { describe, expect, it } from "vitest";
import {
  composerSelectionBlock,
  existingEnvironmentUsable,
  nativeSelectionProjectId,
  nativeSelectionReady,
  spawnEnvironmentFromSelection,
  type ComposerSelectionSnapshot,
} from "../src/composer-selection";
import { useNativeComposerSelection } from "../src/ui/composer-selection-hook";

const request = { type: "reuse" as const, environmentId: "env_1" };
const readyReuse: ComposerSelectionSnapshot = {
  status: "ready",
  scope: { kind: "new-thread", projectId: "proj_a" },
  projectId: "proj_a",
  providerId: "openai",
  model: "gpt",
  reasoningLevel: "medium",
  environment: { kind: "existing", type: "reuse", environmentId: "env_1", hostId: "host_1", path: "/tmp/proj" },
  environmentRequest: request,
  environmentProvenance: { projectId: "proj_a", sectionId: null, hostId: "host_1", path: "/tmp/proj" },
};

describe("native composer selection", () => {
  it("treats a missing SDK hook as unsupported without throwing", () => {
    expect(() => useNativeComposerSelection()).not.toThrow();
    const snapshot = useNativeComposerSelection();
    expect(snapshot.status).toBe("unsupported");
    if (snapshot.status === "unsupported") expect(snapshot.reason).toBe("native-selection-unavailable");
    expect(nativeSelectionReady(snapshot)).toBe(false);
  });

  it("is ready only with host-owned environmentRequest and provenance", () => {
    expect(nativeSelectionReady(readyReuse)).toBe(true);
    expect(nativeSelectionProjectId(readyReuse)).toBe("proj_a");
    expect(composerSelectionBlock(readyReuse)).toBeNull();
    expect(nativeSelectionReady({ status: "resolving", scope: { kind: "new-thread", projectId: "proj_a" } })).toBe(false);
    expect(composerSelectionBlock({ status: "resolving", scope: { kind: "new-thread", projectId: "proj_a" } })).toBe("resolving");
    expect(existingEnvironmentUsable({ kind: "existing", type: "project-default" })).toBe(false);
    expect(existingEnvironmentUsable({ kind: "provisioning", type: "provider", environmentProviderId: "project-checkout" })).toBe(true);
    const checkoutRequest = { type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host_1" }, inputs: { sourceId: "src_1" } };
    const readyCheckout: ComposerSelectionSnapshot = {
      status: "ready",
      scope: { kind: "new-thread", projectId: "proj_a" },
      projectId: "proj_a",
      providerId: "claude-code",
      model: "opus",
      reasoningLevel: "medium",
      environment: { kind: "provisioning", type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host_1" } },
      environmentRequest: checkoutRequest,
      environmentProvenance: { projectId: "proj_a", sectionId: null, hostId: "host_1" },
    };
    expect(nativeSelectionReady(readyCheckout)).toBe(true);
    expect(spawnEnvironmentFromSelection(readyCheckout)).toBe(checkoutRequest);
    expect(nativeSelectionReady({
      ...readyCheckout,
      environment: { kind: "provisioning", type: "provider", environmentProviderId: "project-checkout" },
      environmentRequest: { type: "host", hostId: "host_1", workspace: { type: "personal" } },
    })).toBe(false);
    expect(existingEnvironmentUsable({ kind: "existing", type: "host", workspaceType: "unmanaged" })).toBe(false);
    expect(existingEnvironmentUsable({ kind: "existing", type: "host", workspaceType: "unmanaged", hostId: "host_1", path: "/tmp/proj" })).toBe(true);
  });
});
