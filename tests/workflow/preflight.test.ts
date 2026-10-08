import { execFileSync } from "node:child_process";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/storage/database";
import { commandsScript, createWorkflowPreflight, parseCommandAnswers } from "../../src/rooms/workflow/server/workflow-preflight";
import { runWorkflowTool } from "../../src/rooms/workflow/server/workflow-tools";
import type { WorkflowToolDeps } from "../../src/rooms/workflow/server/workflow-tools";
import { checkRequires, effectiveRequires, preflightRefusal, secretName, toolGroup } from "@lane-pilot/workflow-engine";
import type { RequirePorts } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { builtinWorkflow, builtinWorkflows } from "../../src/rooms/workflow/builtin";
import { wf } from "./engine-helpers";

const requires = (extra: Partial<Workflow["requires"]>): Workflow["requires"] =>
  ({ plugins: [], skills: [], secrets: [], machines: [], env: [], browserSession: false, mcp: [], tools: [], platforms: [], ...extra });

describe("what a requires entry means", () => {
  it("reads an Env Catalog name, an optional one, and ignores prose", () => {
    expect(secretName("TAVILY_API_KEY")).toEqual({ name: "TAVILY_API_KEY", optional: false });
    expect(secretName("MUTAGEN_API_KEY?")).toEqual({ name: "MUTAGEN_API_KEY", optional: true });
    expect(secretName("MUTAGEN_API_KEY (только при use_seo_tools)")).toEqual({ name: "MUTAGEN_API_KEY", optional: true });
    expect(secretName("перечисленные в accounts (ssh/ftp/secret) - только по именам, J7")).toBeNull();
    expect(secretName("an api key")).toBeNull();
  });

  it("splits a tool into the alternatives that count and drops anything that is not a command", () => {
    expect(toolGroup("whisper|whisper-cpp | faster-whisper")).toEqual(["whisper", "whisper-cpp", "faster-whisper"]);
    expect(toolGroup("~/toolkit/telegram/tg")).toEqual(["~/toolkit/telegram/tg"]);
    expect(toolGroup("ffmpeg; rm -rf /")).toEqual([]);
  });
});

describe("the own chains say what they need in words the check understands", () => {
  const need = (id: string) => builtinWorkflow(id)!.requires;
  it("reels need the media tools, insights the logins, the digest the Telegram sender, research and SEO their keys", () => {
    expect(need("reels").tools.map(toolGroup)).toEqual([["ffmpeg"], ["yt-dlp"], expect.arrayContaining(["whisper", "faster-whisper"])]);
    expect(need("insights-post").platforms).toEqual(["threads", "instagram", "vk"]);
    expect(need("x-to-telegram-digest")).toMatchObject({ platforms: ["x"], tools: ["~/toolkit/telegram/tg"] });
    expect(need("web-research").secrets.map(secretName)).toEqual([{ name: "TAVILY_API_KEY", optional: false }]);
    expect(need("seo-cocoon").secrets.map(secretName)).toEqual([{ name: "TAVILY_API_KEY", optional: false }, { name: "MUTAGEN_API_KEY", optional: true }]);
    // The deploy chain describes its accounts in prose: nothing in it is mistaken for a secret name.
    expect(need("deploy").secrets.map(secretName)).toEqual([null]);
  });
});

describe("checkRequires", () => {
  const ports = (extra: RequirePorts = {}): RequirePorts => ({
    skills: async () => ["tavily", "social-browser"], plugins: async () => ["lane-pilot"], mcpServers: async () => ["tavily"],
    secrets: async () => [{ name: "TAVILY_API_KEY", kind: "secret" }], commands: async (groups) => groups.map((group) => group.includes("ffmpeg")),
    socialStatus: async () => "snapshot 3h old\ndomains: threads.com, instagram.com", ...extra,
  });

  it("passes when everything is there", async () => {
    const result = await checkRequires(requires({ skills: ["tavily"], plugins: ["lane-pilot"], mcp: ["tavily"], secrets: ["TAVILY_API_KEY"], tools: ["ffmpeg"], platforms: ["threads"] }), ports());
    expect(result).toMatchObject({ ok: true, issues: [], envRequests: [] });
    expect(result.checked).toHaveLength(6);
  });

  it("names every missing thing and asks for a missing secret with env_request, never for its value", async () => {
    const result = await checkRequires(requires({ skills: ["copywriter"], secrets: ["OPENAI_API_KEY"], tools: ["yt-dlp|youtube-dl"], platforms: ["vk"], mcp: ["jev"] }), ports());
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => `${issue.kind}:${issue.name}:${issue.level}`)).toEqual([
      "skill:copywriter:missing", "mcp:jev:missing", "secret:OPENAI_API_KEY:missing", "tool:yt-dlp | youtube-dl:missing", "platform:vk:missing"]);
    expect(result.envRequests).toEqual([{ name: "OPENAI_API_KEY", kind: "secret", purpose: expect.any(String) }]);
    const text = preflightRefusal(result);
    expect(text).toContain("requirements_missing");
    expect(text).toContain("Call env_request now for OPENAI_API_KEY");
    expect(text).toContain("yt-dlp | youtube-dl is not installed");
  });

  it("does not stop the run for what it cannot ask, nor for an optional secret, and says so", async () => {
    const result = await checkRequires(requires({ secrets: ["MUTAGEN_API_KEY?"], tools: ["ffmpeg"], platforms: ["x", "threads"], skills: ["tavily"] }),
      ports({ commands: undefined, socialStatus: async () => null, skills: async () => { throw new Error("offline"); } }));
    expect(result.ok).toBe(true);
    expect(result.issues.map((issue) => `${issue.name}:${issue.level}`)).toEqual(["tavily:unverified", "MUTAGEN_API_KEY:unverified", "ffmpeg:unverified", "x:unverified", "threads:unverified"]);
    expect(result.envRequests).toEqual([]);
  });

  it("an unreachable Env Catalog is unverified, not missing", async () => {
    const result = await checkRequires(requires({ secrets: ["TAVILY_API_KEY"] }), ports({ secrets: async () => null }));
    expect(result).toMatchObject({ ok: true, issues: [{ kind: "secret", level: "unverified" }] });
  });
});

describe("looking for commands on the machine", () => {
  it("answers per group on a real shell: a name on the PATH, an alternative, a path, a missing one", () => {
    const groups = [["sh"], ["no-such-tool-xyz", "ls"], ["/bin/sh"], ["~/no/such/tool"], ["no-such-tool-xyz"]];
    const out = execFileSync("sh", ["-c", commandsScript(groups)], { encoding: "utf8" });
    expect(parseCommandAnswers(out, groups.length)).toEqual([true, true, true, false, false]);
  });

  it("treats a missing answer as not found", () => {
    expect(parseCommandAnswers("0:yes\n", 2)).toEqual([true, false]);
  });
});

describe("the check wired to the machine", () => {
  it("runs one script and one status command on the PM's machine and turns the answers into issues", async () => {
    const calls: Array<{ method: string; command: string; cwd: string }> = [];
    const ctx = { host: { call: async (method: string, input: { command: string; cwd: string; requestedHostId: string }) => {
      calls.push({ method, command: input.command, cwd: input.cwd });
      if (input.command.includes("social-cookies")) return { exitCode: 0, stdout: "domains: threads.com", stderr: "" };
      return { exitCode: 0, stdout: "0:yes\n1:no\n", stderr: "" };
    } } } as never;
    const preflight = createWorkflowPreflight(ctx, {
      capabilityPorts: () => ({ skills: async () => [{ name: "tavily" }], plugins: async () => [{ id: "lane-pilot", name: "Lane Pilot" }], mcpServers: async () => [], secrets: async () => [] }),
      projectPlace: async () => ({ hostId: "host_a", path: "/work/pm" }),
    });
    const result = await preflight.check(wf({ requires: requires({ tools: ["ffmpeg", "yt-dlp"], platforms: ["threads", "instagram"], skills: ["tavily"] }) }), { projectId: "p", threadId: "t" });
    expect(calls.map((call) => [call.method, call.cwd])).toEqual([["runCommand", "/work/pm"], ["runCommand", "/work/pm"]]);
    expect(result.issues.map((issue) => `${issue.name}:${issue.level}`)).toEqual(["yt-dlp:missing", "instagram:missing"]);
  });

  it("without a machine the commands and logins are not checked, and a failing host call is not a verdict", async () => {
    const none = createWorkflowPreflight({ host: { call: async () => { throw new Error("offline"); } } } as never, {
      capabilityPorts: () => ({}), projectPlace: async () => null, projectPlaceOf: async () => null });
    expect((await none.check(wf({ requires: requires({ tools: ["ffmpeg"] }) }), { projectId: "p" })).issues).toMatchObject([{ kind: "tool", level: "unverified" }]);
    const failing = createWorkflowPreflight({ host: { call: async () => { throw new Error("offline"); } } } as never, {
      capabilityPorts: () => ({}), projectPlace: async () => ({ hostId: "h", path: "/p" }) });
    expect((await failing.check(wf({ requires: requires({ tools: ["ffmpeg"] }) }), { projectId: "p", threadId: "t" })).issues).toMatchObject([{ kind: "tool", level: "unverified" }]);
  });
});

describe("lane_pilot_run_workflow with requirements and a first live run", () => {
  const PROJECT = "proj-1", PM = "pm-1", RUN = "lprun-1";
  function setup(status: Workflow["status"], preflight?: WorkflowToolDeps["preflight"]) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, RUN, PROJECT, "cli");
    setRunThread(db, RUN, PM);
    const workflow = wf({ status, requires: requires({ secrets: ["TAVILY_API_KEY"] }) });
    const started: unknown[] = [];
    const deps: WorkflowToolDeps = {
      db, store: async () => ({ get: (id: string) => (id === workflow.id ? { workflow } : null), list: () => [{ workflow }] }) as never,
      engine: () => ({ start: (input: unknown) => { started.push(input); return { runId: "wfrun_1", created: true, done: new Promise(() => undefined) }; }, get: () => ({ status: "running" }) }) as never,
      runtime: (input) => ({ ctx: {} as never, services: {} as never, ...input }), warn: () => undefined, ...(preflight ? { preflight } : {}),
    };
    return { deps, started };
  }
  const ctx = { threadId: PM, projectId: PROJECT };
  const missingSecret = async () => checkRequires(requires({ secrets: ["TAVILY_API_KEY"] }), { secrets: async () => [] });

  it("does not start when a requirement is missing, and tells the PM to call env_request", async () => {
    const { deps, started } = setup("published", missingSecret);
    const answer = JSON.parse(await runWorkflowTool(deps, { workflowId: "demo", inputs: { query: "q" } }, ctx));
    expect(answer.status).toBe("refused");
    expect(answer.reason).toContain("requirements_missing");
    expect(answer.reason).toContain("env_request");
    expect(answer.envRequests).toEqual([{ name: "TAVILY_API_KEY", kind: "secret", purpose: expect.any(String) }]);
    expect(started).toEqual([]);
  });

  it("starts when the requirements hold, and passes on what it could not check", async () => {
    const { deps, started } = setup("published", async () => checkRequires(requires({ secrets: ["TAVILY_API_KEY"], platforms: ["x"] }), { secrets: async () => [{ name: "TAVILY_API_KEY", kind: "secret" }] }));
    const answer = JSON.parse(await runWorkflowTool(deps, { workflowId: "demo", inputs: { query: "q" } }, ctx));
    expect(answer.workflowRunId).toBe("wfrun_1");
    expect(answer.notChecked).toEqual([expect.stringContaining("x")]);
    expect(started).toHaveLength(1);
  });

  it("a tested workflow starts only as a live trial the owner agreed to, and still has to pass the check", async () => {
    const { deps, started } = setup("tested", async () => ({ ok: true, issues: [], envRequests: [], checked: [] }));
    const refused = JSON.parse(await runWorkflowTool(deps, { workflowId: "demo", inputs: { query: "q" } }, ctx));
    expect(refused.reason).toContain("liveTrial: true");
    expect(started).toEqual([]);
    expect(JSON.parse(await runWorkflowTool(deps, { workflowId: "demo", inputs: { query: "q" }, liveTrial: true }, ctx)).workflowRunId).toBe("wfrun_1");
    const blocked = setup("tested", missingSecret);
    expect(JSON.parse(await runWorkflowTool(blocked.deps, { workflowId: "demo", inputs: { query: "q" }, liveTrial: true }, ctx)).reason).toContain("requirements_missing");
    // A draft stays refused whatever liveTrial says.
    expect(JSON.parse(await runWorkflowTool(setup("draft").deps, { workflowId: "demo", inputs: { query: "q" }, liveTrial: true }, ctx)).reason).toContain("not_runnable");
  });
});

/** The ids `bb plugin list --json` printed on 2026-10-08, of the plugins a chain may need; a chain that names another id is blocked at start. */
const REAL_PLUGIN_IDS = new Set(["lane-pilot", "tasks", "browser-automation", "env-catalog", "image-studio", "memory", "secrets", "workflows"]);

describe("the plugins the shipped chains require are real BB plugin ids", () => {
  it("every requires.plugins and every node's plugins entry names a real plugin (the tracker is `tasks`, not `bb-tasks`)", () => {
    const named: string[] = [];
    for (const found of builtinWorkflows()) for (const name of effectiveRequires(found).plugins) named.push(`${found.id}:${name}`);
    expect(named.length).toBeGreaterThan(20);
    expect(named.filter((entry) => !REAL_PLUGIN_IDS.has(entry.slice(entry.indexOf(":") + 1)))).toEqual([]);
    expect(named.filter((entry) => entry.endsWith(":tasks")).map((entry) => entry.split(":")[0]).sort()).toEqual(["issue-discover", "issue-full", "issue-quick"]);
  });

  it("an older file's `bb-tasks` is read as `tasks`", async () => {
    const result = await checkRequires(requires({ plugins: ["lane-pilot", "bb-tasks"] }), { plugins: async () => ["lane-pilot", "tasks"] });
    expect(result.ok).toBe(true);
    const missing = await checkRequires(requires({ plugins: ["bb-tasks"] }), { plugins: async () => ["lane-pilot"] });
    expect(missing.issues[0]).toMatchObject({ kind: "plugin", name: "bb-tasks", level: "missing" });
  });
});
