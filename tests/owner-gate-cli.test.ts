import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { claimActivation, createRun, openDatabase, setRunThread } from "../src/database";
import { anamnesisAccessOfCli, anamnesisAccessOfRequest } from "../src/anamnesis/access";
import { SCHEDULE_USAGE, scheduleCliMethod } from "../src/server/schedule-cli";

const projectId = "proj_cli_gate";
const pmThreadId = "thr_cli_gate_pm";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

type Form = { threadId: string; title: string; payload: { detail?: string; question: string } };
type Handler = (input: unknown, ctx?: unknown) => Promise<Record<string, any>>;

const verified = { experimental_vkCaller: { kind: "owner-cli", evidence: "owner-signature" } };
const forged = { experimental_vkCaller: { kind: "owner-cli", evidence: "cli-header" } };
const agent = { experimental_vkCaller: { kind: "agent-thread", threadId: pmThreadId, evidence: "thread-token" } };
const anonymous = { experimental_vkCaller: { kind: "unknown", evidence: "none" } };

async function setup(answer: (form: Form) => Promise<unknown> | unknown = () => new Promise(() => undefined)) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const forms: Form[] = [];
  Object.assign(bb.ui as object, { requestInput: async (form: Form) => { forms.push(form); return answer(form); } });
  let handlers: Record<string, Handler> = {};
  const rpc = bb.rpc as unknown as { register: (contract: unknown, map: Record<string, Handler>) => unknown };
  const register = rpc.register.bind(rpc);
  rpc.register = (contract, map) => { handlers = map; return register(contract, map); };
  createRun(db, "run-cli-gate", projectId, "bb", "/repo");
  setRunThread(db, "run-cli-gate", pmThreadId);
  claimActivation(db, { projectId, pmThreadId, runId: "run-cli-gate" });
  (harness as unknown as { sdk: { stub: (name: string, fn: unknown) => void } }).sdk.stub("hosts.list", async () => []);
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const cli = (argv: string[], ctx?: unknown) => harness.behavior.runCli(argv, ctx as never);
  const settled = () => new Promise((resolve) => setTimeout(resolve, 30));
  return { forms, cli, settled, harness, rpc: (method: string, input: unknown, ctx?: unknown) => handlers[method]!(input, ctx) };
}

const definition = JSON.stringify({ projectId, name: "x", task: { kind: "script", hostId: "h", cwd: "/tmp", command: "echo hi" }, when: { type: "once", delay: "1h" } });

describe("bb lane-pilot schedule: who may change the board", () => {
  it("every subcommand is a read or the twin of a gated RPC", () => {
    const subs = SCHEDULE_USAGE.split("\n").map((line) => line.split(/\s+/)[3]!);
    const reads = new Set(["list", "show", "history", "preview"]);
    for (const sub of subs) expect(reads.has(sub) || scheduleCliMethod(sub) !== undefined, sub).toBe(true);
    expect(scheduleCliMethod("create")).toBe("schedule_upsert");
    expect(scheduleCliMethod("run-now")).toBe("schedule_run_now");
  });

  it("a script made from an agent's shell is put to the owner and not stored", async () => {
    const s = await setup();
    const result = await s.cli(["schedule", "create", definition], { ...agent, threadId: pmThreadId });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/only the owner does that.*asked in the PM chat/s);
    await s.settled();
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]!.payload.detail).toContain("echo hi");
    const listed = await s.cli(["schedule", "list", "--json"], agent);
    expect(JSON.parse(listed.stdout).schedules).toHaveLength(0);
  });

  it("the same command with the client's own owner mark in a thread is an agent's; without a thread it is an unverified owner's, with a form", async () => {
    const s = await setup();
    const inThread = await s.cli(["schedule", "create", definition], { ...forged, threadId: "thr_other" });
    expect(inThread.stdout).toMatch(/only the owner does that/);
    const bare = await s.cli(["schedule", "create", definition], forged);
    expect(bare.exitCode).toBe(1);
    expect(bare.stdout).toMatch(/cannot be told from an agent's/);
  });

  it("curl-like callers are refused; a verified owner and a core without marks create it", async () => {
    const s = await setup();
    expect((await s.cli(["schedule", "create", definition], anonymous)).stdout).toMatch(/Refused/);
    expect((await s.cli(["schedule", "run-now", "sch_none"], anonymous)).exitCode).toBe(1);
    const made = await s.cli(["schedule", "create", definition], verified);
    expect(made.stdout).toContain("\"ok\": true");
    const old = await s.cli(["schedule", "create", definition.replace("\"x\"", "\"y\"")], {});
    expect(old.stdout).toContain("\"ok\": true");
    expect(s.forms).toHaveLength(0);
  });

  it("reading the board is open to an agent", async () => {
    const s = await setup();
    expect((await s.cli(["schedule", "list"], agent)).exitCode).toBe(0);
    expect((await s.cli(["schedule", "preview", definition], agent)).exitCode).toBe(0);
  });
});

describe("the automation's own commands", () => {
  it("`workflow-trigger`, called by the automation with no identity, is not stopped by the caller check", async () => {
    const s = await setup();
    const result = await s.cli(["workflow-trigger", projectId, "no-such-workflow"], anonymous);
    expect(result.stdout).toContain("unknown_workflow");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/Refused/);
  });
});

describe("the anamnesis: reading, sensitive reading and changing", () => {
  it("sorts a request by what it does", () => {
    const access = anamnesisAccessOfRequest;
    expect(access({ op: "status" })).toBe("read");
    expect(access({ op: "list" })).toBe("read");
    expect(access({ op: "list", includeSensitive: true })).toBe("sensitive-read");
    expect(access({ op: "get", id: "skill:x", includeSensitive: true })).toBe("sensitive-read");
    expect(access({ op: "history", id: "skill:x" })).toBe("sensitive-read");
    expect(access({ op: "whoami", includeSensitive: true })).toBe("sensitive-read");
    expect(access({ op: "collect", mode: "plan" })).toBe("read");
    expect(access({ op: "collect", mode: "run" })).toBe("write");
    expect(access({ op: "forget", all: true })).toBe("write");
    expect(access({ op: "sources", set: { source: "git", enabled: false } })).toBe("write");
    expect(access({ op: "add", record: { sensitivity: "private" } })).toBe("write");
    expect(access({ op: "add", record: { sensitivity: "public" } })).toBe("write-owner");
    expect(access({ op: "edit", id: "x", patch: { title: "t" } })).toBe("write");
    expect(access({ op: "edit", id: "x", patch: { status: "confirmed" } })).toBe("write-owner");
    expect(access({ op: "edit", id: "x", patch: { sensitivity: "private" } })).toBe("write-owner");
    expect(access({ op: "edit", id: "x", patch: { sensitivity: "sensitive" } })).toBe("write");
    expect(access({ op: "no-such-op" })).toBe("write");
    expect(access(undefined)).toBe("write");
  });

  it("sorts a command line by what it does", () => {
    const access = anamnesisAccessOfCli;
    for (const argv of [["status"], ["list", "--kind", "skill"], ["show", "skill:x"], ["whoami"], ["card"], ["review"], ["host"], ["sources"], ["config"], ["load"], ["help"], ["--help"], []]) expect(access(argv), argv.join(" ")).toBe("read");
    for (const argv of [["list", "--include-sensitive"], ["show", "x", "--include-sensitive"], ["whoami", "--include-sensitive"], ["history", "x"]]) expect(access(argv), argv.join(" ")).toBe("sensitive-read");
    for (const argv of [["forget", "--all", "--yes"], ["forget", "x"], ["forget", "--source", "git", "--yes"], ["reject", "x"], ["load", "--run"], ["sources", "--set", "git=off"],
      ["config", "--roots", "/a"], ["add", "--kind", "skill", "--key", "k", "--title", "t", "--reason", "r"], ["edit", "x", "--title", "t", "--reason", "r"], ["edit", "x", "--sensitivity", "sensitive", "--reason", "r"]]) {
      expect(access(argv), argv.join(" ")).toBe("write");
    }
    for (const argv of [["confirm", "x"], ["add", "--sensitivity", "public", "--kind", "skill", "--key", "k", "--title", "t", "--reason", "r"], ["edit", "x", "--sensitivity", "public", "--reason", "r"],
      ["edit", "x", "--status", "confirmed", "--reason", "r"], ["load", "--classify", "--allow-sensitive-to-jev"], ["load", "--run", "--classify", "--yes", "--allow-sensitive-to-jev"]]) {
      expect(access(argv), argv.join(" ")).toBe("write-owner");
    }
    // A line that does not parse does nothing.
    expect(access(["list", "--no-such-flag"])).toBe("read");
    expect(access(["frobnicate"])).toBe("write");
  });

  it("an agent never gets sensitive records or the owner-only changes; other changes go to the owner", async () => {
    const s = await setup();
    const ctx = { ...agent, threadId: pmThreadId };
    expect((await s.cli(["anamnesis", "list", "--include-sensitive"], ctx)).stderr).toMatch(/not shown to an agent/);
    expect((await s.cli(["anamnesis", "show", "skill:x", "--include-sensitive"], ctx)).stderr).toMatch(/not shown to an agent/);
    for (const argv of [["confirm", "skill:x"], ["edit", "skill:x", "--sensitivity", "public", "--reason", "r"], ["load", "--run", "--classify", "--yes", "--allow-sensitive-to-jev"]]) {
      expect((await s.cli(["anamnesis", ...argv], ctx)).stderr, argv.join(" ")).toMatch(/only the owner does that, not an agent/);
    }
    expect(s.forms).toHaveLength(0);
    const forget = await s.cli(["anamnesis", "forget", "--all", "--yes"], ctx);
    expect(forget).toMatchObject({ exitCode: 1 });
    expect(forget.stderr).toMatch(/only the owner does that.*asked in the PM chat/s);
    await s.settled();
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]!.payload.detail).toContain("forget");
  });

  it("a writer, helper or stage thread reads nothing; the PM of a run reads what is not sensitive", async () => {
    const s = await setup();
    (s.harness as unknown as { sdk: { stub: (name: string, fn: unknown) => void } }).sdk.stub("threads.get", async () => ({ id: "thr_writer_unknown", parentThreadId: pmThreadId, originPluginId: "lane-pilot" }));
    const writer = await s.cli(["anamnesis", "list"], { experimental_vkCaller: { kind: "agent-thread", threadId: "thr_writer_unknown", evidence: "thread-token" } });
    expect(writer.exitCode).toBe(1);
    expect(writer.stderr).toMatch(/not available to writers, helpers or stage threads/);
    const pm = await s.cli(["anamnesis", "list"], agent);
    expect(pm.stderr ?? "").not.toMatch(/Refused|only the owner|confirmation/);
  });

  it("an unverified owner reads what is not sensitive, and meets the form for the rest; curl gets nothing", async () => {
    const s = await setup();
    expect((await s.cli(["anamnesis", "list"], forged)).stderr ?? "").not.toMatch(/Refused|confirmation/);
    for (const argv of [["list", "--include-sensitive"], ["forget", "--all", "--yes"], ["confirm", "skill:x"]]) {
      expect((await s.cli(["anamnesis", ...argv], forged)).stderr, argv.join(" ")).toMatch(/cannot be told from an agent's/);
    }
    for (const argv of [["list"], ["status"], ["forget", "x"]]) expect((await s.cli(["anamnesis", ...argv], anonymous)).stderr, argv.join(" ")).toMatch(/Refused/);
  });

  it("the verified owner and a core without marks are not stopped", async () => {
    const s = await setup();
    for (const ctx of [verified, {}]) {
      const result = await s.cli(["anamnesis", "list", "--include-sensitive"], ctx);
      expect(result.stderr ?? "").not.toMatch(/Refused|confirmation|not shown to an agent/);
    }
    expect(s.forms).toHaveLength(0);
  });

  it("the RPC applies the same rules", async () => {
    const s = await setup();
    await expect(s.rpc("anamnesis", { request: { op: "list" } }, anonymous)).rejects.toThrow(/Refused/);
    await expect(s.rpc("anamnesis", { request: { op: "forget", all: true } }, forged)).rejects.toThrow(/cannot be told from an agent's/);
    await expect(s.rpc("anamnesis", { request: { op: "get", id: "skill:x", includeSensitive: true } }, agent)).rejects.toThrow(/not shown to an agent/);
    await expect(s.rpc("anamnesis", { request: { op: "edit", id: "skill:x", patch: { status: "confirmed" }, reason: "r" } }, agent)).rejects.toThrow(/only the owner does that, not an agent/);
  });
});
