import { describe, expect, it, vi } from "vitest";
import { experimental_selectedSkillMentions } from "@get-bb/plugin-sdk/provider-bridge";
import { nativeSkillSelection, skillThreadRoute, skillWorkspaceRoute } from "../../src/rooms/workflow/server/services/workflow-skill-select";

const skill = (name: string, extra: Record<string, unknown> = {}) => ({ name, source: "skill", origin: "project", argumentHint: null, ...extra });
const bbWith = (commands: unknown[] | Error) => ({
  sdk: {
    projects: {
      commands: vi.fn(async () => {
        if (commands instanceof Error) throw commands;
        return { commands };
      }),
    },
  },
});
const select = (bb: unknown, over: Record<string, unknown> = {}) =>
  nativeSkillSelection({ bb, projectId: "p", provider: "codex", route: { environmentId: "e1" }, skills: ["a-skill"], prompt: "DO THE THING", ...over } as never);

describe("nativeSkillSelection", () => {
  it("codex attaches every resolved selection as skill mentions before the unchanged prompt part", async () => {
    const bb = bbWith([skill("a-skill"), skill("b-skill", { argumentHint: "[args]" }), { name: "not-a-skill", source: "command", origin: "builtin" }]);
    const res = await select(bb, { skills: ["a-skill", "b-skill"], prompt: "PROMPT BODY" });
    expect(res.notes).toEqual([]);
    expect(res.parts).toHaveLength(2);
    expect(res.parts![0]).toMatchObject({ type: "text", text: "/a-skill /b-skill" });
    expect(res.parts![1]).toEqual({ type: "text", text: "PROMPT BODY", mentions: [] });
    const mentions = res.parts![0]!.mentions as Array<{ start: number; end: number; resource: Record<string, unknown> }>;
    expect(mentions.map((m) => [m.start, m.end])).toEqual([[0, 8], [9, 17]]);
    expect(mentions[0]!.resource).toMatchObject({ kind: "command", source: "skill", trigger: "/", name: "a-skill", origin: "project", label: "a-skill" });
    expect(mentions[1]!.resource).toMatchObject({ argumentHint: "[args]" });
    // The real SDK recognizer must see both as selected skill mentions and none in the prompt part.
    const seen = experimental_selectedSkillMentions({ text: res.parts![0]!.text, mentions: res.parts![0]!.mentions as never });
    expect(seen.map((m) => m.resource.name)).toEqual(["a-skill", "b-skill"]);
    expect(experimental_selectedSkillMentions({ text: res.parts![1]!.text, mentions: res.parts![1]!.mentions as never })).toEqual([]);
    expect(bb.sdk.projects.commands).toHaveBeenCalledWith({ projectId: "p", provider: "codex", environmentId: "e1" });
  });

  it("every emitted skill mention carries argumentHint as string|null — the spawn schema requires the key", async () => {
    const hintOf = async (row: Record<string, unknown>) => {
      const bb = bbWith([row]);
      const res = await select(bb, { provider: "claude-code", skills: [String(row.name)] });
      expect(res.parts).toHaveLength(2);
      const resource = (res.parts![0]!.mentions as Array<{ resource: Record<string, unknown> }>)[0]!.resource;
      expect("argumentHint" in resource).toBe(true);
      return resource.argumentHint;
    };
    // Catalog rows emit argumentHint:null for skills (native579 ru-text); missing/empty must normalize the same way.
    expect(await hintOf(skill("ru-text", { origin: "user" }))).toBeNull();
    const noKey = { name: "no-hint", source: "skill", origin: "user" };
    expect(await hintOf(noKey)).toBeNull();
    expect(await hintOf(skill("empty-hint", { argumentHint: "" }))).toBeNull();
    expect(await hintOf(skill("hinted", { argumentHint: "[args]" }))).toBe("[args]");
  });

  it("claude-code attaches exactly one requested-and-resolved selection and refuses multiplicity", async () => {
    const bb = bbWith([skill("a-skill"), skill("b-skill")]);
    const one = await select(bb, { provider: "claude-code", skills: ["a-skill"] });
    expect(one.parts).toHaveLength(2);
    const many = await select(bb, { provider: "claude-code", skills: ["a-skill", "b-skill"] });
    expect(many.parts).toBeNull();
    expect(many.notes.join(" ")).toContain("selection_transport_unsupported");
    // Two requested but only one resolved must not attach either: the missing pick stays visible.
    const partial = await bbWith([skill("a-skill")]);
    const res = await select(partial, { provider: "claude-code", skills: ["a-skill", "b-skill"] });
    expect(res.parts).toBeNull();
    expect(res.notes.join(" ")).toContain("selection_unresolved");
    expect(res.notes.join(" ")).toContain("selection_transport_unsupported");
  });

  it("other providers get a diagnostic without any catalog call", async () => {
    const bb = bbWith([skill("a-skill")]);
    const res = await select(bb, { provider: "opencode2" });
    expect(res.parts).toBeNull();
    expect(res.notes.join(" ")).toContain("selection_transport_unsupported");
    expect(bb.sdk.projects.commands).not.toHaveBeenCalled();
  });

  it("unresolved, ambiguous and missing surfaces are named diagnostics, never a faked selection", async () => {
    const bb = bbWith([skill("dup"), skill("dup", { origin: "user" }), skill("ok")]);
    const res = await select(bb, { skills: ["missing", "dup", "ok"] });
    expect(res.parts).toHaveLength(2);
    const text = res.notes.join("\n");
    expect(text).toContain("selection_unresolved");
    expect(text).toContain("'missing'");
    expect(text).toContain("selection_ambiguous");
    expect(text).toContain("'dup'");
  });

  it("no skills, no route and lookup failure all keep the plain prompt path", async () => {
    const bb = bbWith([]);
    expect((await select(bb, { skills: [] })).parts).toBeNull();
    expect(bb.sdk.projects.commands).not.toHaveBeenCalled();
    const noRoute = await select(bb, { route: null });
    expect(noRoute.parts).toBeNull();
    expect(noRoute.notes.join(" ")).toContain("selection_workspace_unverified");
    const failed = await select(bbWith(new Error("boom")));
    expect(failed.parts).toBeNull();
    expect(failed.notes.join(" ")).toContain("selection_transport_unsupported");
    const empty = await select(bbWith([{ name: "cmd", source: "command" }]));
    expect(empty.notes.join(" ")).toContain("selection_unresolved");
    for (const malformed of [{ commands: "nope" }, { commands: [null] }, { commands: [42] }]) {
      const res = await select({ sdk: { projects: { commands: async () => malformed } } });
      expect(res.parts).toBeNull();
      expect(res.notes.join(" ")).toContain("selection_transport_unsupported");
    }
  });
});

describe("skill route resolution stays total", () => {
  const bbThrowing = (impl: () => unknown) => ({
    sdk: {
      environments: { get: impl },
      threads: { get: impl },
      projects: { get: async () => { throw new Error("sources down"); } },
    },
  });

  it("sync throws and async rejections in routing reads resolve to null, never escape", async () => {
    const sync = bbThrowing(() => { throw new Error("sync boom"); });
    expect(await skillWorkspaceRoute(sync as never, "p", { type: "reuse", environmentId: "e" })).toBeNull();
    expect(await skillThreadRoute(sync as never, "t")).toBeNull();
    const asyncFail = bbThrowing(async () => { throw new Error("async boom"); });
    expect(await skillWorkspaceRoute(asyncFail as never, "p", { type: "host", hostId: "h", workspace: { path: "/w" } })).toBeNull();
    expect(await skillThreadRoute(asyncFail as never, "t")).toBeNull();
  });

  it("a continued thread without its own projectId is unverified, not the PM project", async () => {
    const bb = {
      sdk: {
        threads: { get: async () => ({ providerId: "codex", environmentId: "e", status: "idle" }) },
        environments: { get: async () => ({ status: "ready", projectId: "p-real" }) },
      },
    };
    expect(await skillThreadRoute(bb as never, "t")).toBeNull();
  });
});
