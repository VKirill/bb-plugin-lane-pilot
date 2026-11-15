import { beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_selectedSkillMentions } from "@get-bb/plugin-sdk/provider-bridge";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { fullAccessSpawn, findThreadsByMetadata } from "../../src/rooms/platform/server";

vi.mock("../../src/rooms/platform/server", async (original) => ({
  ...(await original<typeof import("../../src/rooms/platform/server")>()),
  fullAccessSpawn: vi.fn(async () => ({ id: "thr-new" })),
  findThreadsByMetadata: vi.fn(async () => null),
  projectFolder: vi.fn(async () => ({ hostId: "h", path: "/w" })),
}));
vi.mock("../../src/rooms/runs/server", async (original) => ({
  ...(await original<typeof import("../../src/rooms/runs/server")>()),
  requireHelperSpawn: () => ({ mode: "optional", policy: null }),
  helperChildPlacement: async () => ({ projectId: "p" }),
  requiredPolicyField: () => ({}),
}));

const SKILL = { name: "a-skill", source: "skill", origin: "project", argumentHint: null };

function world(envs: Record<string, unknown>, commands: unknown[] = [SKILL], threads: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const bb = {
    log: { warn: vi.fn() },
    storage: { kv: { get: async () => null, set: async () => undefined } },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => threads[threadId] ?? { id: threadId, status: "idle", environmentId: "env" },
        send: async (args: unknown) => { sent.push(args); return {}; },
        output: async () => ({ output: "{}" }),
      },
      environments: { get: async ({ environmentId }: { environmentId: string }) => envs[environmentId] ?? null },
      projects: {
        get: async () => ({ sources: [{ hostId: "h", path: "/w" }] }),
        commands: vi.fn(async () => ({ commands })),
      },
      hosts: { list: async () => [] },
    },
  };
  const rt = {
    pmThreadId: "pm", projectId: "p", runId: "run1",
    ctx: {
      db: { prepare: () => ({ get: () => undefined }) }, host: { call: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, log: () => undefined, isDisposed: () => false,
      effectiveProjectSettings: async () => ({ values: {} }), ownedAgents: async () => ({}), bb,
    },
    services: {},
  };
  return { rt, bb, sent };
}

const request = (over: Record<string, unknown> = {}) => ({
  rt: undefined as never, workflowRunId: "wf1", stepKey: "s", nodeId: "n", spawnKey: "k", title: "t", prompt: "DO THE THING",
  fields: [], role: "analyst", resolved: true, ...over,
});
type SpawnArgs = Parameters<typeof fullAccessSpawn>[1];
const spawnArgs = (): SpawnArgs => {
  const args = vi.mocked(fullAccessSpawn).mock.calls.at(-1)?.[1];
  if (!args) throw new Error("fullAccessSpawn was not called");
  return args;
};

beforeEach(() => vi.clearAllMocks());

describe("workflow helper native skill selection", () => {
  it("codex spawn sends input mention parts instead of prompt, resolved against the ready project environment", async () => {
    const { rt, bb } = world({ env: { path: "/w", hostId: "h", status: "ready", projectId: "p" } });
    await createWorkflowAgents().run(request({ rt, skills: ["a-skill"], provider: "codex" }) as never).catch(() => undefined);
    const args = spawnArgs();
    if (!("input" in args)) throw new Error("expected input spawn args");
    expect(args.input).toEqual([
      { type: "text", text: "/a-skill", mentions: [expect.objectContaining({ start: 0, end: 8, resource: expect.objectContaining({ source: "skill", name: "a-skill" }) })] },
      { type: "text", text: expect.stringContaining("DO THE THING"), mentions: [] },
    ]);
    expect("prompt" in args).toBe(false);
    expect(bb.sdk.projects.commands).toHaveBeenCalledWith({ projectId: "p", provider: "codex", environmentId: "env" });
  });

  it("no skills means no catalog call and the plain prompt path", async () => {
    const { rt, bb } = world({ env: { path: "/w", hostId: "h", status: "ready", projectId: "p" } });
    await createWorkflowAgents().run(request({ rt, provider: "codex" }) as never).catch(() => undefined);
    expect(bb.sdk.projects.commands).not.toHaveBeenCalled();
    const args = spawnArgs();
    expect("prompt" in args ? typeof args.prompt : "missing").toBe("string");
    expect("input" in args).toBe(false);
  });

  it("a ready environment of a foreign project is not a selection target", async () => {
    const { rt, bb } = world({ env: { path: "/w", hostId: "h", status: "ready", projectId: "other" } });
    await createWorkflowAgents().run(request({ rt, skills: ["a-skill"], provider: "codex" }) as never).catch(() => undefined);
    expect(bb.sdk.projects.commands).not.toHaveBeenCalled();
    expect(bb.log.warn.mock.calls.flat().join(" ")).toContain("selection_workspace_unverified");
    const args = spawnArgs();
    expect("prompt" in args ? typeof args.prompt : "missing").toBe("string");
  });

  it("intoThread resolves the continued thread's own provider, project and environment", async () => {
    const { rt, bb, sent } = world(
      { "env-t": { status: "ready", projectId: "p-real", hostId: "h", path: "/w" } },
      [SKILL],
      { "thr-x": { id: "thr-x", status: "idle", providerId: "codex", projectId: "p-real", environmentId: "env-t" } },
    );
    await createWorkflowAgents().run(request({ rt, skills: ["a-skill"], intoThread: "thr-x" }) as never).catch(() => undefined);
    expect(bb.sdk.projects.commands).toHaveBeenCalledWith({ projectId: "p-real", provider: "codex", environmentId: "env-t" });
    expect(sent).toHaveLength(1);
    const input = (sent[0] as { input: Array<{ type: string; text: string; mentions: Array<{ start: number; end: number; resource: { kind: string; source: string; trigger: string; name: string } }> }> }).input;
    expect(input[0]).toMatchObject({ type: "text", text: "/a-skill" });
    expect(input[1]!.mentions).toEqual([]);
    expect(input[1]!.text).toContain("DO THE THING");
    // The actual SDK recognizer accepts the sent mention and finds none in the prompt part.
    const seen = experimental_selectedSkillMentions({ text: input[0]!.text, mentions: input[0]!.mentions as never });
    expect(seen.map((m) => m.resource.name)).toEqual(["a-skill"]);
    expect(experimental_selectedSkillMentions({ text: input[1]!.text, mentions: input[1]!.mentions as never })).toEqual([]);
  });

  it("a provider start failure recomputes selection for the fallback provider", async () => {
    vi.mocked(fullAccessSpawn).mockRejectedValueOnce(new Error("vk_required_session_policy_unenforceable"));
    const { rt, bb } = world({ env: { path: "/w", hostId: "h", status: "ready", projectId: "p" } });
    await createWorkflowAgents().run(request({ rt, skills: ["a-skill"], provider: "codex" }) as never).catch(() => undefined);
    const providers = (bb.sdk.projects.commands as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { provider: string }).provider);
    expect(providers[0]).toBe("codex");
    expect(providers.length).toBeGreaterThan(1);
    expect(providers[1]).not.toBe("codex");
  });

  it("a keyed thread found by metadata is reused without a new spawn or catalog call", async () => {
    vi.mocked(findThreadsByMetadata).mockResolvedValueOnce([{ id: "existing" }] as never);
    const { rt, bb } = world({ env: { path: "/w", hostId: "h", status: "ready", projectId: "p" } });
    await createWorkflowAgents().run(request({ rt, skills: ["a-skill"], provider: "codex" }) as never).catch(() => undefined);
    expect(fullAccessSpawn).not.toHaveBeenCalled();
    expect(bb.sdk.projects.commands).not.toHaveBeenCalled();
  });
});
