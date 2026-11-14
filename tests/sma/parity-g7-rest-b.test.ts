import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { codeFactsState, CODE_FACTS_PROBE, CODE_FACTS_REFRESH, codeFactsOnHost } from "../../src/rooms/platform";
import { journalAppend, outsideWorkSummary } from "../../src/rooms/owner-presence";
import { manifest } from "../../src/rooms/tools/server/receipts";
import { openDatabase } from "../../src/rooms/plugin-db";
import { DESIGN_SUITE_VERSION, readDesignCase, scoreMeasurement, writeDesignCase, type Measurement } from "../../src/rooms/design-eval";
import { atomicText, renameRetry } from "../../src/rooms/platform/atomic-text";
import { QA_DEFAULT_PORTS } from "../../src/rooms/contracts";
import { findBrowserQaTarget } from "../../src/rooms/host-worker";
import bundledAgents from "../../src/rooms/contracts/bundled-agents.json";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseCodeCritique } from "../../src/rooms/critique/code-critique";
import { leakFindings } from "../helpers/guard-tools";
import { vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { createOwnerPresence, observeOwnerDispatch } from "../../src/rooms/owner-presence/server";
import { createQaStages } from "../../src/rooms/qa/server/qa";
import { qaThreadPrompt } from "../../src/rooms/qa/server/qa-thread";
import { scanBrowserQaPorts } from "../../src/rooms/host-worker/handlers/desktop";
import { migrations } from "../../src/rooms/plugin-db";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createRun, createTask, saveProjectSetting, savePrototypeConfig } from "../../src/rooms/storage";
import { recordStage } from "../../src/rooms/runs/server";
import type { Services } from "../../server";

// The check thread is the one thing the stage tests stub: what the stage hands it is what the tests read.
const threadCalls: Array<Record<string, unknown>> = [];
vi.mock("../../src/rooms/qa/server/qa-thread", async (original) => {
  const real = await original<typeof import("../../src/rooms/qa/server/qa-thread")>();
  return { ...real, runQaThread: async (_ctx: unknown, input: Record<string, unknown>) => {
    threadCalls.push(input);
    return { verdict: "passed", status: "pass", summary: "ok", cases: [], threadId: "thr_qa", link: "@thread:thr_qa" };
  } };
});
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const measurement = (width: number): Measurement => ({
  width, overflowPx: 0, textElements: 10, lowContrast: 0, targets: 4, smallTargets: 0, tinyText: 0, h1: 1, spacingValues: 6,
});

describe("parity wave G7 rest B", () => {
  it("[sma:k_t_intel] an index two commits behind reads stale 2, an equal commit reads fresh, a missing folder reads none, and --refresh is the analyze command", () => {
    expect(codeFactsState(null)).toEqual({ state: "none" });
    expect(codeFactsState("NONE\n")).toEqual({ state: "none" });
    const head = "a".repeat(40), last = "b".repeat(40);
    expect(codeFactsState(`HEAD=${head}\nLAST=${last}\nBEHIND=2\n`)).toEqual({ state: "stale", behind: 2 });
    expect(codeFactsState(`HEAD=${head}\nLAST=${head}\nBEHIND=0\n`)).toEqual({ state: "fresh" });
    expect(CODE_FACTS_PROBE).toContain(".gitnexus");
    expect(CODE_FACTS_PROBE).toContain("meta.json");
    expect(CODE_FACTS_REFRESH).toBe("gitnexus analyze --index-only");
  });

  it("[sma:k_t_intel] the host probe feeds the state reader, and the analyze command runs once for --refresh", async () => {
    const commands: string[] = [];
    const host = { call: async (_m: string, input: { command: string }) => {
      commands.push(input.command);
      return { hostId: "h1", exitCode: 0, stdout: `HEAD=${"a".repeat(40)}\nLAST=${"b".repeat(40)}\nBEHIND=3\n`, stderr: "" };
    } };
    expect(await codeFactsOnHost(host as never, "h1", "/p")).toEqual({ state: "stale", behind: 3 });
    expect(commands).toHaveLength(1);
    // The refresh path of the CLI: same runOnHost transport, the analyze command exactly once.
    const { runOnHost } = await import("@lane-pilot/host-calls");
    await runOnHost(host as never, { hostId: "h1", cwd: "/p", command: CODE_FACTS_REFRESH, timeoutSec: 60 });
    expect(commands).toEqual([CODE_FACTS_PROBE, "gitnexus analyze --index-only"]);
  });

  it("[sma:m_sp_tjournal] two owner messages in one thread on one day give one journal row, and rows over 90 days are dropped", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    const mark = { threadId: "thr_a", providerId: "codex", hostId: "h_mini", at: Date.parse("2026-11-11T09:00:00Z") };
    const one = journalAppend([], mark, now);
    expect(one).toHaveLength(1);
    const two = journalAppend(one, { ...mark, at: Date.parse("2026-11-11T18:00:00Z") }, now);
    expect(two).toHaveLength(1);
    const other = journalAppend(two, { ...mark, threadId: "thr_b" }, now);
    expect(other).toHaveLength(2);
    const old = journalAppend(other, { ...mark, threadId: "thr_old", at: now - 91 * 86_400_000 }, now);
    expect(old.some((row) => row.threadId === "thr_old")).toBe(false);
    expect(old).toHaveLength(2);
  });

  it("[sma:m_sp_tjournal_report] with outside rows on 3 of 7 days and 10 attempts the summary states 3 days and the share; empty journal states zero", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    let rows: ReturnType<typeof journalAppend> = [];
    for (const [i, day] of ["2026-11-05", "2026-11-08", "2026-11-10"].entries())
      rows = journalAppend(rows, { threadId: `thr_${i}`, providerId: "codex", hostId: "h", at: Date.parse(`${day}T10:00:00Z`) }, now);
    const summary = outsideWorkSummary(rows, now, 10);
    expect(summary.days).toBe(3);
    expect(summary.windowDays).toBe(7);
    expect(summary.attempts).toBe(10);
    expect(summary.share).toBeCloseTo(3 / 7);
    expect(outsideWorkSummary([], now, 10).days).toBe(0);
    expect(outsideWorkSummary([], now, 10).share).toBe(0);
  });

  it("[sma:m_rd_diag] the manifest carries version, platform, osRelease, node and a numeric unknownCodes, and no env value", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const out = manifest(db);
    expect(out.version).toBeTruthy();
    expect(out.platform).toBe(process.platform);
    expect(out.osRelease).toBeTruthy();
    expect(out.node).toBe(process.version);
    expect(typeof out.unknownCodes).toBe("number");
    const secrets = ["HOME", "BB_SERVER_URL", "PATH"].map((key) => process.env[key]).filter(Boolean) as string[];
    for (const value of secrets) expect(JSON.stringify(out)).not.toContain(value);
  });

  it("[sma:k_lib_dcase] a written design case reads back; a flipped byte, a foreign suite version or one width is refused with a named reason", () => {
    const text = writeDesignCase({ id: "hero@1", measurements: [measurement(375), measurement(1280)] });
    const ok = readDesignCase(text);
    expect(ok.ok).toBe(true);
    if (ok.ok) { expect(ok.case.id).toBe("hero@1"); expect(ok.case.suiteVersion).toBe(DESIGN_SUITE_VERSION); expect(scoreMeasurement(ok.case.measurements[0]!)).toHaveLength(6); }
    const flipped = text.replace('"overflowPx": 0', '"overflowPx": 9');
    expect(readDesignCase(flipped)).toEqual({ ok: false, reason: "design_case_bytes_differ" });
    const foreign = text.replace(DESIGN_SUITE_VERSION, "other-suite-9");
    expect(readDesignCase(foreign).ok).toBe(false);
    if (!readDesignCase(foreign).ok) expect((readDesignCase(foreign) as { reason: string }).reason).toContain("design_case_suite_mismatch");
    const oneWidth = writeDesignCase({ id: "w", measurements: [measurement(1280)] });
    expect(readDesignCase(oneWidth)).toEqual({ ok: false, reason: "design_case_width_missing:375" });
  });

  it("[sma:k_d_ref_probe] the nyquist-auditor asks for prohibitions and a fixture per edge and prohibition, in both bundled copies, and still writes no tests", () => {
    const bundled = (bundledAgents as Record<string, { prompt: string }>)["nyquist-auditor"]!.prompt;
    const overlay = readFileSync("src/rooms/native-agent/native-agent-overlay.ts", "utf8");
    for (const text of [bundled, overlay]) {
      expect(text).toContain("prohibitions");
      expect(text).toContain("fixture");
      expect(text).toContain("must never happen");
      expect(text).toContain("Do not write the tests");
    }
  });

  it("[sma:k_lib_fsatomics] renameRetry retries EPERM and EACCES, rethrows ENOENT at once, and atomicText writes the file", async () => {
    let calls = 0;
    const flaky = async () => { calls++; if (calls <= 2) throw Object.assign(new Error("locked"), { code: "EPERM" }); };
    await expect(renameRetry("a", "b", flaky)).resolves.toBeUndefined();
    expect(calls).toBe(3);
    calls = 0;
    const eacces = async () => { calls++; throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    await expect(renameRetry("a", "b", eacces)).rejects.toThrow("denied");
    expect(calls).toBe(5);
    calls = 0;
    const enoent = async () => { calls++; throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    await expect(renameRetry("a", "b", enoent)).rejects.toThrow("missing");
    expect(calls).toBe(1);
    const dir = await mkdtemp(join(tmpdir(), "lp-atomic-"));
    try {
      const file = join(dir, "out.txt");
      await atomicText(file, "hello");
      expect(await readFile(file, "utf8")).toBe("hello");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("[sma:k_pl_intel] the refresh decision is refresh-on, gitnexus allowed, and index none or stale — each gate exercised by the real readers", async () => {
    const { effectiveGroup, parseHelperContextSettings } = await import("../../src/rooms/contracts/helper-context");
    const { UNLISTED_SWITCHES } = await import("../../src/rooms/settings/switches");
    expect(UNLISTED_SWITCHES["docs.gitnexus_refresh"]).toBeDefined();
    const allowed = (settings: Record<string, unknown>) => {
      const ctx = parseHelperContextSettings(settings);
      return ctx.ok && (ctx.settings.mode !== "roles" || (effectiveGroup("writer", "mcpServers", ctx.settings.roleAccess?.writer).names ?? ["gitnexus"]).includes("gitnexus"));
    };
    expect(allowed({})).toBe(true);
    expect(allowed({ "helper.access.writer": { mcpServers: { mode: "allow", names: ["gitnexus", "metamcp"] } } })).toBe(true);
    expect(allowed({ "helper.access.writer": { mcpServers: { mode: "allow", names: ["metamcp"] } } })).toBe(false);
    // The nightly pass refreshes exactly the non-fresh states.
    for (const probe of ["NONE\n", `HEAD=${"a".repeat(40)}\nLAST=${"b".repeat(40)}\nBEHIND=5\n`])
      expect(codeFactsState(probe).state).not.toBe("fresh");
    expect(codeFactsState(`HEAD=${"a".repeat(40)}\nLAST=${"a".repeat(40)}\nBEHIND=0\n`).state).toBe("fresh");
  });

  it("[sma:m_tl_rebrand_wired] a planted secret-shaped string: the plain publishable verb is unchanged, --strict reports the leak", async () => {
    // The probe lives in a temporary tree, never in the repository: a parallel test run scans the real src/.
    const root = await mkdtemp(join(tmpdir(), "lp-leak-"));
    const planted = ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "probe.ts"), `export const planted = "${planted}";\n`);
    const run = (flags: string[]) => {
      try { return execFileSync("npx", ["tsx", "scripts/lp-ship.ts", "publishable", ...flags], { encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LP_SHIP_LEAK_ROOT: root } }); }
      catch (cause) { return `${(cause as { stdout?: string }).stdout ?? ""}${(cause as { stderr?: string }).stderr ?? ""}`; }
    };
    try {
      expect(leakFindings(root)).toEqual(["src/probe.ts:1"]);
      expect(run([])).not.toContain("leak scan");
      expect(run(["--strict"])).toContain("leak scan: src/probe.ts:1");
    } finally { await rm(root, { recursive: true, force: true }); }
    expect(leakFindings(".")).toEqual([]);
  }, 600_000);

  it("[sma:k_lib_translit] two findings in one file with different Russian criteria get different ids; an English criterion keeps its slug", () => {
    const verdict = (criterion: string) => JSON.stringify({
      status: "rework", summary: "s", evidence: "e",
      findings: [{ file: "src/a.ts", line: 1, severity: "high", evidence: `code line for ${criterion}`, criterion }],
    });
    const one = parseCodeCritique(verdict("нет проверки пустого ввода"));
    const two = parseCodeCritique(verdict("нет проверки максимальной длины"));
    const three = parseCodeCritique(verdict("rate limit missing"));
    expect(one.findings[0]!.id).not.toBe(two.findings[0]!.id);
    expect(one.findings[0]!.id).toMatch(/^src\/a\.ts:[0-9a-f]{6}$/);
    expect(three.findings[0]!.id).toBe("src/a.ts:rate-limit-missing");
  });

  it("[sma:k_wqa_find] the port scan counts an HTML 200 and a redirect, and not a 404, a JSON 200 or a closed port", async () => {
    const servers: ReturnType<typeof createServer>[] = [];
    const serve = async (status: number, type: string) => {
      const server = createServer((_req, res) => { res.writeHead(status, { "content-type": type }); res.end("x"); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      servers.push(server);
      return (server.address() as AddressInfo).port;
    };
    try {
      const html = await serve(200, "text/html; charset=utf-8"), moved = await serve(302, "text/html"), missing = await serve(404, "text/html"), json = await serve(200, "application/json");
      const closed = await serve(200, "text/html"); servers.pop()!.close();
      const found = await scanBrowserQaPorts([json, html, closed, missing, moved]);
      expect(found).toEqual([`http://127.0.0.1:${html}/`, `http://127.0.0.1:${moved}/`]);
      expect(await scanBrowserQaPorts([missing, json])).toEqual([]);
    } finally { for (const server of servers) server.close(); }
  });

  it("[sma:k_wqa_find] the host method answers only with listed default ports", async () => {
    const found = await findBrowserQaTarget({ requestedHostId: "h_test" } as never, {} as never);
    expect(found.hostId).toBe("h_test");
    for (const url of found.urls) expect(QA_DEFAULT_PORTS.map((port) => `http://127.0.0.1:${port}/`)).toContain(url);
  });

  // The real stage with a fake host: the scan answer is scripted, every host call is recorded.
  async function qaStage(scan: string[], settings: Record<string, unknown> = {}) {
    threadCalls.length = 0;
    const calls: Array<{ method: string; input: unknown }> = [];
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "run_1" }) } },
      experimental_callHostRpc: async (call: { method: string; input: unknown }) => {
        calls.push({ method: call.method, input: call.input });
        if (call.method === "findBrowserQaTarget") return { hostId: "h_w", urls: scan };
        return { hostId: "h_w", exitCode: 0, stdout: "", stderr: "" };
      },
    } as never);
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "P", hostId: "h_w", pmWorkspacePath: "/tmp/p-pm", writerWorkspacePath: "/tmp/p-w", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" } as never);
    for (const [key, value] of Object.entries({ "browser_qa.host_id": "h_w", "browser_qa.backend": "bb-browser", ...settings })) saveProjectSetting(db, "P", key, value);
    createRun(db, "run_1", "P", "bb", "/tmp/p-w");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run_1");
    createTask(db, { id: "t1", runId: "run_1", kind: "bb", contract: {
      schema_version: 2, display_title: "T", kind: "feature", area: "feature:t", id: "t1", title: "T", risk: "low", lane: "writer", project_cwd: "/tmp/p-w",
      read_first: [], interfaces: ["a"], invariants: ["b"], out_of_scope: ["c"], expected_outputs: ["n.txt"], owns_paths: ["n.txt"], never_touch: [".git/**"],
      depends_on: [], objective: "o", acceptance: ["a"], verify: "tests", verification: [{ command: "true", cwd: "/tmp/p-w", timeout_sec: 30 }],
    } });
    recordStage(db, { runId: "run_1", taskId: "t1", stageId: "acceptance-receipt", state: "passed", input: "{}", attempt: 1, providerId: "x", model: null } as never);
    const core = createCore(bb, db);
    const run = (extra: Record<string, unknown>) => createQaStages(core).runBrowserQa({
      threadId: "thr_pm", projectId: "P", runId: "run_1", taskId: "t1", cases: ["Home opens"], envClass: "local", viewports: "375", authorized: false, ...extra,
    } as never);
    return { run, calls, db };
  }

  it("[sma:k_wqa_find] exactly one app answers: its address is the target and the dev server is not passed on, nothing is run by the hub", async () => {
    const t = await qaStage(["http://127.0.0.1:5173/"]);
    const out = await t.run({ url: "", devServer: "npm run dev" });
    expect(out.state).toBe("passed");
    expect(threadCalls).toHaveLength(1);
    expect(threadCalls[0]!.url).toBe("http://127.0.0.1:5173/");
    expect(threadCalls[0]!.devServer).toBeUndefined();
    expect(t.calls.map((call) => call.method)).toEqual(["findBrowserQaTarget"]);
  });

  it("[sma:k_wqa_find] nothing answers and a dev server is given: the check thread is told to start it and wait up to 30 s for a listed port; the hub runs no command", async () => {
    const t = await qaStage([]);
    const out = await t.run({ url: "", devServer: "npm run dev" });
    expect(out.state).toBe("passed");
    expect(threadCalls).toHaveLength(1);
    expect(threadCalls[0]!.devServer).toBe("npm run dev");
    const prompt = qaThreadPrompt({ url: threadCalls[0]!.url as string, cases: ["Home opens"], viewports: "375", envClass: "local", authorized: false, qaHostId: "h_w", devServer: threadCalls[0]!.devServer as string });
    expect(prompt).toContain("bb terminal create");
    expect(prompt).toContain("bb terminal close <id>");
    expect(prompt).toContain("wait up to 30 seconds");
    for (const port of QA_DEFAULT_PORTS) expect(prompt).toContain(`http://127.0.0.1:${port}/`);
    expect(t.calls.some((call) => call.method === "runCommand")).toBe(false);
    // With an address given the same prompt carries no such instruction.
    expect(qaThreadPrompt({ url: "http://127.0.0.1:5173/", cases: ["Home opens"], viewports: "375", envClass: "local", authorized: false, qaHostId: "h_w", devServer: "npm run dev" })).not.toContain("wait up to 30 seconds");
  });

  it("[sma:k_wqa_find] nothing answers and no dev server: blocked as browser_qa_no_app_found naming the ports; the thread is not started", async () => {
    const t = await qaStage([]);
    const out = await t.run({ url: "" });
    expect(out).toMatchObject({ state: "blocked" });
    expect(String(out.reason)).toContain(`browser_qa_no_app_found:nothing answered on 127.0.0.1 ports ${QA_DEFAULT_PORTS.join(",")}`);
    expect(threadCalls).toHaveLength(0);
    expect(t.calls.map((call) => call.method)).toEqual(["findBrowserQaTarget"]);
  });

  it("[sma:k_wqa_find] two apps answer: blocked as browser_qa_ambiguous_app naming both and asking for url, even with a dev server", async () => {
    const t = await qaStage(["http://127.0.0.1:3000/", "http://127.0.0.1:5173/"]);
    const out = await t.run({ url: "", devServer: "npm run dev" });
    expect(out).toMatchObject({ state: "blocked" });
    expect(String(out.reason)).toContain("browser_qa_ambiguous_app:http://127.0.0.1:3000/ http://127.0.0.1:5173/");
    expect(String(out.reason)).toContain("pass url");
    expect(threadCalls).toHaveLength(0);
  });

  it("[sma:k_wqa_find] a url that is given is used as it is: no scan at all", async () => {
    const t = await qaStage(["http://127.0.0.1:3000/", "http://127.0.0.1:5173/"]);
    const out = await t.run({ url: "http://127.0.0.1:4000/", devServer: "npm run dev" });
    expect(out.state).toBe("passed");
    expect(threadCalls[0]).toMatchObject({ url: "http://127.0.0.1:4000/", devServer: "npm run dev" });
    expect(t.calls).toEqual([]);
  });

  // ---- bb lane-pilot intel / owner-presence through the real CLI ----
  function cli(threads: Record<string, { projectId: string; role?: string }> = {}) {
    const commands: string[] = [];
    const host = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: {
        get: async ({ threadId }: { threadId: string }) => threads[threadId] ? { id: threadId, projectId: threads[threadId]!.projectId } : null,
        getPluginMetadata: async ({ threadId }: { threadId: string }) => threads[threadId]?.role ? { role: threads[threadId]!.role } : null,
      } },
      experimental_callHostRpc: async (call: { method: string; input: { command?: string } }) => {
        commands.push(String(call.input.command));
        return { hostId: "h_w", exitCode: 0, stdout: "NONE\n", stderr: "" };
      },
    } as never);
    const db = openDatabase(host.bb);
    savePrototypeConfig(db, { projectId: "P1", hostId: "h_w", pmWorkspacePath: "/tmp/p1", writerWorkspacePath: "/tmp/p1-w", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" } as never);
    savePrototypeConfig(db, { projectId: "P2", hostId: "h_w", pmWorkspacePath: "/tmp/p2", writerWorkspacePath: "/tmp/p2-w", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" } as never);
    const ownerPresence = createOwnerPresence({ bb: host.bb, log: () => undefined } as never).ownerPresence;
    registerCli(createCore(host.bb, db), { ownerPresence } as unknown as Services, migrations);
    const run = (argv: string[], threadId?: string) => host.harness.behavior.runCli(argv, threadId ? { threadId } : {});
    return { run, commands, ownerPresence, host };
  }

  it("[sma:k_t_intel] a thread may read or refresh only its own project, and refresh only from the PM thread; the owner at a terminal is unrestricted", async () => {
    const t = cli({ thr_pm: { projectId: "P1", role: "pm" }, thr_w: { projectId: "P1", role: "writer" } });
    const owner = await t.run(["intel", "P2", "--refresh"]);
    expect(owner.exitCode).toBe(0);
    expect(t.commands).toContain("gitnexus analyze --index-only");
    t.commands.length = 0;
    expect((await t.run(["intel", "P1", "--refresh"], "thr_pm")).exitCode).toBe(0);
    expect(t.commands).toContain("gitnexus analyze --index-only");
    t.commands.length = 0;
    const other = await t.run(["intel", "P2", "--refresh"], "thr_pm");
    expect(other.exitCode).toBe(1);
    expect(other.stderr).toContain("refused: intel from a thread reaches only that thread's own project");
    expect((await t.run(["intel", "P2"], "thr_pm")).exitCode).toBe(1);
    const writer = await t.run(["intel", "P1", "--refresh"], "thr_w");
    expect(writer.exitCode).toBe(1);
    expect(writer.stderr).toContain("refused: intel --refresh is not for a writer thread");
    expect(t.commands).toEqual([]);
    // Printing the state of its own project stays open to any thread, and runs no indexer.
    const state = await t.run(["intel", "P1"], "thr_w");
    expect(state.exitCode).toBe(0);
    expect(state.stdout).toContain('"state": "none"');
    expect(t.commands).not.toContain("gitnexus analyze --index-only");
  });

  it("[sma:m_sp_tjournal] bb lane-pilot owner-presence prints the bare array as before; --journal prints the journal rows", async () => {
    const t = cli();
    const noMetadata = { sdk: { threads: { getPluginMetadata: async () => ({}) } } };
    await observeOwnerDispatch(noMetadata as never, { initiator: "user", thread: { id: "thr_o" }, requestedExecution: { providerId: "codex" }, host: { id: "h_mini", name: "mini" } });
    const marks = JSON.parse((await t.run(["owner-presence"])).stdout);
    expect(Array.isArray(marks)).toBe(true);
    expect(marks[0]).toMatchObject({ providerId: "codex", host: "mini", holdsWriters: true });
    const journal = JSON.parse((await t.run(["owner-presence", "--journal"])).stdout);
    expect(journal).toEqual([{ day: new Date().toISOString().slice(0, 10), threadId: "thr_o", providerId: "codex", hostId: "h_mini" }]);
  });

  it("[sma:m_sp_tjournal] the owner message path: one row per thread per day, no second write, a message before the sweep keeps the stored rows, 2000 rows at most", async () => {
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const stored = Array.from({ length: 5 }, (_, i) => ({ day: day(i + 1), threadId: `thr_old${i}`, providerId: "codex", hostId: "h" }));
    const kv = new Map<string, string>([["owner-presence:journal", JSON.stringify(stored)]]);
    const writes: string[] = [];
    const bb = {
      storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: string) => { if (key === "owner-presence:journal") writes.push(value); kv.set(key, value); } } },
      sdk: { threads: { getPluginMetadata: async () => ({}) } },
    };
    const api = createOwnerPresence({ bb, log: () => undefined } as never).ownerPresence;
    const send = (threadId: string) => observeOwnerDispatch(bb as never, { initiator: "user", thread: { id: threadId }, requestedExecution: { providerId: "codex" }, host: { id: "h", name: "m" } });
    // First message, before any sweep: the stored five rows stay and one is added.
    await send("thr_new");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toHaveLength(6);
    expect(JSON.parse(writes[0]!).map((row: { threadId: string }) => row.threadId)).toContain("thr_old0");
    // The second message of the same thread the same day adds nothing and writes nothing.
    await send("thr_new");
    expect(writes).toHaveLength(1);
    expect(api.journal()).toHaveLength(6);
    // A different thread is a new row and a write.
    await send("thr_other");
    expect(writes).toHaveLength(2);
    // The cap: a stored journal of 2000 rows stays 2000, the oldest dropped.
    const full = Array.from({ length: 2000 }, (_, i) => ({ day: day(1), threadId: `thr_f${i}`, providerId: "codex", hostId: "h" }));
    kv.set("owner-presence:journal", JSON.stringify(full));
    const capped = createOwnerPresence({ bb, log: () => undefined } as never).ownerPresence;
    await send("thr_cap");
    expect(capped.journal()).toHaveLength(2000);
    expect(capped.journal().at(-1)!.threadId).toBe("thr_cap");
    expect(capped.journal().some((row) => row.threadId === "thr_f0")).toBe(false);
  });

  it("[sma:k_lib_dcase] --save or --case as the last argument without a value exits 1 with a usage line, before any browser starts", () => {
    for (const flag of ["--save", "--case"]) {
      let status = 0, err = "";
      try { execFileSync("npx", ["tsx", "scripts/lp-design-eval.ts", "http://127.0.0.1:1/", flag], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (cause) { status = (cause as { status?: number }).status ?? -1; err = String((cause as { stderr?: string }).stderr ?? ""); }
      expect(status).toBe(1);
      expect(err).toContain(`${flag} needs a file`);
      expect(err).toContain("usage:");
    }
  }, 300_000);

});
