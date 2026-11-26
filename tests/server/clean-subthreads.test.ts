import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { coreRequiredSessionAdvertisement } from "../../src/rooms/contracts";
import {
  bindSubthreadProjectSettings,
  cleanSubthreadPolicyField,
  fullAccessSpawn,
  resolveCleanSubthreadRole,
} from "../../src/rooms/platform/server";

function makeCleanSpawnHost() {
  const spawned: Array<Record<string, unknown>> = [];
  let seq = 0;
  const advertised = coreRequiredSessionAdvertisement();
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        spawn: async (args: Record<string, unknown>) => {
          spawned.push(args);
          seq += 1;
          return { id: `thr_sub_${seq}` };
        },
      },
      providers: {
        list: async () => [
          {
            id: "claude-code",
            displayName: "Claude Code",
            available: true,
            capabilities: { supportsServiceTier: true },
            serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }],
          },
          {
            id: "codex",
            displayName: "Codex",
            available: true,
            capabilities: { supportsServiceTier: true },
            serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }],
          },
        ],
        models: async () => ({ models: [] }),
      },
    } as never,
  });
  (bb as unknown as { agents: Record<string, unknown> }).agents = {
    experimental_vkRequiredSessionPolicy: () => advertised,
  };
  return { bb, spawned };
}

describe("clean subthread session policy enforcement", () => {
  it("maps internal helper/subthread roles to canonical clean role profiles and leaves PM orchestrators untouched", () => {
    expect(resolveCleanSubthreadRole("pm", false)).toBeNull();
    expect(resolveCleanSubthreadRole("pm", true)).toBeNull();
    expect(resolveCleanSubthreadRole("bench-pm", true)).toBeNull();

    expect(resolveCleanSubthreadRole("self-repair", false)).toBe("code-repair");
    expect(resolveCleanSubthreadRole("rules-analyzer", true)).toBe("rules-analyzer");
    expect(resolveCleanSubthreadRole("workspace-provisioner", false)).toBe("workspace-provisioner");
    expect(resolveCleanSubthreadRole("workflow-architect", true)).toBe("workflow-architect");
    expect(resolveCleanSubthreadRole("harness-editor", false)).toBe("harness-editor");
    expect(resolveCleanSubthreadRole("lead", false)).toBe("lead");
    expect(resolveCleanSubthreadRole("specialist:security", true)).toBe("specialist:security");
    expect(resolveCleanSubthreadRole("specialist", true, "perf")).toBe("specialist:perf");
    expect(resolveCleanSubthreadRole("custom-subthread", true)).toBe("analyst");
    expect(resolveCleanSubthreadRole(null, true)).toBe("analyst");
    expect(resolveCleanSubthreadRole(null, false)).toBeNull();
  });

  it("attaches a required clean session policy and standard serviceTier across previously uncovered fullAccessSpawn sites", async () => {
    const { bb, spawned } = makeCleanSpawnHost();

    for (const role of [
      "self-repair",
      "rules-analyzer",
      "workspace-provisioner",
      "workflow-architect",
      "harness-editor",
      "lead",
    ]) {
      await fullAccessSpawn(bb, {
        projectId: "proj_1",
        providerId: "claude-code",
        model: "claude-sonnet-4-6",
        serviceTier: "fast",
        parentThreadId: "thr_parent",
        pluginMetadata: { role },
        prompt: `run ${role}`,
      } as never);
    }

    expect(spawned).toHaveLength(6);
    for (const call of spawned) {
      expect(call.serviceTier).toBe("default");
      const binding = call.experimental_vkRequiredSessionPolicy as {
        version: number;
        policy: {
          skills: { mode: string; names: string[] };
          bbPlugins: { mode: string; names: string[] };
          nativePlugins: { mode: string; names: string[] };
        };
      };
      expect(binding).toBeDefined();
      expect(binding.version).toBe(1);
      expect(binding.policy.skills.mode).toBe("allow");
      expect(binding.policy.bbPlugins.mode).toBe("allow");
      expect(binding.policy.bbPlugins.names).toEqual(
        expect.arrayContaining(["environment-project-checkout", "project-folders"]),
      );
      expect(binding.policy.bbPlugins.names).not.toContain("aif-helper");
      expect(binding.policy.nativePlugins.names).toEqual([]);
    }
  });

  it("does not narrow PM orchestrators, explicit caller policies, or helperMode=inherit", async () => {
    const { bb, spawned } = makeCleanSpawnHost();

    await fullAccessSpawn(bb, {
      projectId: "proj_1",
      providerId: "claude-code",
      model: "claude-opus-4-6",
      pluginMetadata: { role: "pm" },
      prompt: "pm root",
    } as never);

    await fullAccessSpawn(bb, {
      projectId: "proj_1",
      providerId: "codex",
      model: "gpt-5.4",
      parentThreadId: "thr_pm",
      pluginMetadata: { role: "writer", helperMode: "inherit" },
      prompt: "inherit helper",
    } as never);

    const customPolicy = { policy: { required: true, skills: { mode: "allow", names: ["custom-skill"] } } };
    await fullAccessSpawn(bb, {
      projectId: "proj_1",
      providerId: "codex",
      model: "gpt-5.4",
      parentThreadId: "thr_pm",
      pluginMetadata: { role: "writer" },
      experimental_vkRequiredSessionPolicy: customPolicy,
      prompt: "custom policy writer",
    } as never);

    expect(spawned[0]?.experimental_vkRequiredSessionPolicy).toBeUndefined();
    expect(spawned[1]?.experimental_vkRequiredSessionPolicy).toBeUndefined();
    expect(spawned[2]?.experimental_vkRequiredSessionPolicy).toBe(customPolicy);
  });

  it("applies a clean analyst profile (keeping projectInstructions) to generic parented subthreads and respects project inherit mode", () => {
    const { bb } = makeCleanSpawnHost();
    const field = cleanSubthreadPolicyField(bb, {
      projectId: "proj_roles",
      parentThreadId: "thr_coordinator",
      providerId: "codex",
      pluginMetadata: {},
    });
    const policy = (field.experimental_vkRequiredSessionPolicy as {
      policy: { skills: { names: string[] }; bbPlugins: { names: string[] }; projectInstructions?: boolean };
    }).policy;
    expect(policy.skills.names).toEqual([]);
    expect(policy.bbPlugins.names).toEqual(["environment-project-checkout", "project-folders"]);
    expect(policy.projectInstructions).not.toBe(false);

    bindSubthreadProjectSettings(bb, (pid) =>
      pid === "proj_inherit" ? { "helper.context_mode": "inherit" } : {},
    );
    const inherited = cleanSubthreadPolicyField(bb, {
      projectId: "proj_inherit",
      parentThreadId: "thr_coordinator",
      providerId: "codex",
      pluginMetadata: { role: "writer" },
    });
    expect(inherited).toEqual({});
  });
});
