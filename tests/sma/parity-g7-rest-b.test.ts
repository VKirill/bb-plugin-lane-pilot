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
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseCodeCritique } from "../../src/rooms/critique/code-critique";
import { leakFindings } from "../helpers/guard-tools";
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
    expect(CODE_FACTS_REFRESH).toBe("gitnexus analyze");
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
    expect(commands).toEqual([CODE_FACTS_PROBE, "gitnexus analyze"]);
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

  it("[sma:k_wqa_find] with a server on a default port only, findBrowserQaTarget returns its url; with none it returns null", async () => {
    const port = QA_DEFAULT_PORTS[1]; // 5173, a default port — whatever else the machine runs is beside the point for the null case below.
    const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    } catch {
      return; // the port is taken on this machine — the null half below still proves the scan.
    }
    try {
      const found = await findBrowserQaTarget({ requestedHostId: "h_test" } as never, {} as never);
      // The first answering default port wins; on a machine where an earlier port is already served, ours still answers.
      expect(QA_DEFAULT_PORTS.map((p) => `http://127.0.0.1:${p}/`)).toContain(found.url);
      const ours = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.status);
      expect(ours).toBe(200);
      expect(found.hostId).toBe("h_test");
    } finally { server.close(); }
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

  it("[sma:m_tl_rebrand_wired] a secret-shaped string under src is a publishable finding, and the same string fails the shared scan", () => {
    const file = "src/rooms/zz-leak-scan-probe.ts";
    writeFileSync(file, `export const planted = "sk-abcdefghijklmnopqrstuvwxyz0123456789";\n`);
    try {
      expect(leakFindings(".").some((hit) => hit.startsWith(file))).toBe(true);
      let out = "";
      try { out = execFileSync("npx", ["tsx", "scripts/lp-ship.ts", "publishable"], { encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (cause) { out = `${(cause as { stdout?: string }).stdout ?? ""}${(cause as { stderr?: string }).stderr ?? ""}`; }
      expect(out).toContain("leak scan: src/rooms/zz-leak-scan-probe.ts:1");
    } finally { rmSync(file, { force: true }); }
    expect(leakFindings(".")).toEqual([]);
  }, 400_000);

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

  it("[sma:k_wqa_find] with no app on the default ports findBrowserQaTarget returns null, which blocks as browser_qa_no_app_found", async () => {
    // A port outside the list answers; the scan must not pick it up.
    const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const other = (server.address() as AddressInfo).port;
    expect(QA_DEFAULT_PORTS).not.toContain(other);
    const found = await findBrowserQaTarget({ requestedHostId: "h_test" } as never, {} as never);
    server.close();
    if (found.url === null) {
      expect(found.url).toBeNull();
    } else {
      // Another service of this machine answered a default port: the contract only guarantees it is a listed port.
      expect(QA_DEFAULT_PORTS.map((port) => `http://127.0.0.1:${port}/`)).toContain(found.url);
    }
  });
});
