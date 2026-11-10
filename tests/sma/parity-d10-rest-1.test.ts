import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase, createAttempt, createRun, getAttempt } from "../../src/rooms/plugin-db";
import { createCanary, poolReadiness, type PoolChain } from "../../src/rooms/stability/server/canary";
import { createReconcile } from "../../src/rooms/stability/server/reconcile";
import { walkWriterChain } from "../../src/rooms/writer/server/writer-hold";
import { coverageRows, untermedGaps } from "../../src/rooms/coverage/model";
import { runCoverageCli } from "../../src/rooms/coverage/cli";
import { instructionForms } from "../../src/rooms/project-life/instruction-forms";
import { mergeFrontmatter, parseFrontmatter, setFrontmatter } from "../../src/rooms/docs/docs-lint";
import { BB_AGENT_SESSIONS } from "../../src/rooms/native-agent/native-agent-overlay";

const DAY = 86_400_000;

function ctx() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const kv = new Map<string, unknown>();
  return {
    bb: { ...bb, storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } },
      sdk: { ...bb.sdk, threads: { send: async () => ({}) }, projects: { list: async () => [] } },
      log: { warn: () => undefined, info: () => undefined } },
    db: openDatabase(bb), isDisposed: () => false, log: () => undefined,
  } as never;
}

/** The hold sources of writer-hold.ts with one open breaker; every other source holds nothing. */
const holdDeps = (openKeys: string[]) => ({
  breaker: { snapshot: (now = Date.now()) => openKeys.map((key) => ({ key, state: "open" as const, failures: 3, openedAt: now, lastOutcome: "exhausted" as const })) },
  presence: undefined,
  usage: { hold: async () => null },
  coreHosts: () => true,
});

describe("pool readiness and the green word (parity d10-rest-1)", () => {
  it("[sma:m_ac_pool_ready] the pool's readiness counts the enabled workers and names each blocked one with its reason", async () => {
    const chain: PoolChain = {
      projectId: "proj", hostId: "hub", settings: {},
      members: [{ providerId: "claude-code", model: "sonnet" }, { providerId: "codex", model: "gpt" }],
    };
    const deps = holdDeps(["codex/gpt"]);
    const ready = await poolReadiness([chain], (members, input) => walkWriterChain(members, input, deps as never));
    expect(ready.enabled).toBe(2);
    expect(ready.blocked).toHaveLength(1);
    expect(ready.blocked[0]!.key).toBe("codex/gpt");
    expect(ready.blocked[0]!.reason).toMatch(/^writer_provider_unavailable:breaker_open/);
    expect(ready.blocked[0]!.projectIds).toEqual(["proj"]);
  });

  it("[sma:m_green] green is said only when no enabled worker is blocked; a free fallback does not hide a held one", async () => {
    const c = ctx();
    const canary = createCanary(c, undefined, async () => ({ enabled: 2, blocked: [{ key: "codex/gpt", projectIds: ["proj"], reason: "writer_provider_unavailable:breaker_open:codex/gpt" }] }));
    const blocked = await canary.status();
    expect(blocked.green).toBe(false);
    expect(blocked.pool.blocked[0]!.key).toBe("codex/gpt");
    const free = createCanary(ctx(), undefined, async () => ({ enabled: 2, blocked: [] }));
    expect((await free.status()).green).toBe(true);
  });

  it("[sma:m_not_green] a not-green status names each blocked worker with the reason its tasks are refused with", async () => {
    const c = ctx();
    const deps = holdDeps(["codex/gpt"]);
    const canary = createCanary(c, undefined, async () => poolReadiness([
      { projectId: "proj", hostId: "hub", settings: {}, members: [{ providerId: "claude-code", model: "sonnet" }, { providerId: "codex", model: "gpt" }] },
    ], (members, input) => walkWriterChain(members, input, deps as never)));
    const report = await canary.status();
    expect(report.green).toBe(false);
    expect(report.pool.blocked).toEqual([{ key: "codex/gpt", projectIds: ["proj"], reason: expect.stringMatching(/^writer_provider_unavailable:breaker_open/) }]);
  });

  it("[sma:m_not_green] lp-canary.sh prints each blocked worker with its reason, and exits non-zero only for a tripped canary", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-canary-parity-"));
    const bb = join(dir, "bb");
    writeFileSync(bb, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({
      version: "0.1.0", faults: 0, rate: 0, tripped: false, green: false, samples: [],
      window: { open: true, attempts: 1, minutes: 3 },
      pool: { works: true, held: [], enabled: 2, blocked: [{ key: "codex/gpt", projectIds: ["proj"], reason: "writer_provider_unavailable:breaker_open:codex/gpt" }] },
    })}\nJSON\n`);
    chmodSync(bb, 0o755);
    const script = fileURLToPath(new URL("../../scripts/lp-canary.sh", import.meta.url));
    const notGreen = spawnSync("bash", [script], { encoding: "utf8", timeout: 30_000, env: { ...process.env, BB_CLI: bb } });
    expect(notGreen.stdout).toContain("codex/gpt: writer_provider_unavailable:breaker_open");
    expect(notGreen.status).toBe(0);
  });

  it("[sma:m_confirm_later] a cancel whose stop was unseen at start-up is ended by the next re-check once the thread is idle, and stays open while it is active", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    createAttempt(db, { id: "att-1", runId: "run", taskId: "task-1" });
    db.prepare("UPDATE lane_pilot_attempt SET state='cancel_requested', thread_id='thr-1' WHERE id='att-1'").run();
    let status: string = "active";
    const stops: string[] = [];
    const c = {
      acceptedTaskWorkspace: () => ({}), configForRun: async () => null, refreshRun: () => undefined,
      isDisposed: () => false, log: () => undefined, db,
      bb: { ...bb, log: { warn: () => undefined, info: () => undefined },
        sdk: { ...bb.sdk, threads: { stop: async (args: { threadId: string }) => { stops.push(args.threadId); return {}; },
          get: async () => ({ status }), listRunning: async () => [] } },
        storage: { kv: { get: async () => null, set: async () => undefined } } },
    } as never;
    const reconcile = createReconcile(c, { resumeDispatch: async () => ({ resumed: false, why: "test" }), rollback: { noteStopped: async () => ({ recorded: false }) }, startWriterTask: () => undefined } as never);
    expect(await reconcile.recheckCancels()).toEqual([]);
    expect(getAttempt(db, "att-1")!.state).toBe("cancel_requested");
    status = "idle";
    expect(await reconcile.recheckCancels()).toEqual(["att-1"]);
    expect(getAttempt(db, "att-1")!.state).toBe("canceled");
    expect(stops.length).toBeGreaterThanOrEqual(2);
    // The re-check waits out the same bounded 30 s window the start-up resume waits.
  }, 45_000);

  it("[sma:rl_terms] an uncovered node without a term or the owner's word is a gap; with the term it is not", () => {
    const row = { kind: "mechanism" as const, id: "tools.demo", status: "none" as const, live: [], tests: [], note: "no drill runs it" };
    expect(untermedGaps([row])).toHaveLength(1);
    expect(untermedGaps([{ ...row, note: "no drill runs it; owner: later" }])).toHaveLength(0);
    expect(untermedGaps([{ ...row, note: "deferred: deferral:rl-42" }])).toHaveLength(0);
    // The live registry gives every uncovered node a term, so the command's verdict is green.
    expect(untermedGaps(coverageRows())).toEqual([]);
    expect(runCoverageCli(["--json"]).exitCode).toBe(0);
  });

  it("[sma:k_d_tpl_instructions] instructionForms gives the CLAUDE.md, Copilot and preferences forms, each pointing at PROJECT.md", () => {
    const forms = instructionForms({ name: "X", test: "npm test" });
    for (const body of [forms.claudeMd, forms.copilotInstructions, forms.preferences]) expect(body).toContain("PROJECT.md");
    expect(forms.claudeMd).toContain("# X");
    expect(forms.copilotInstructions).toContain("Copilot");
    expect(forms.preferences).toContain("npm test");
    expect(forms.preferences).toContain("Forbidden");
    expect(BB_AGENT_SESSIONS["project-onboarder"]).toContain("instructionForms");
  });

  it("[sma:k_t_frontmatter] set changes one key and leaves the body byte-identical; merge adds a list value once", () => {
    const content = "---\ntitle: Old\ntags: [a, b]\n---\n\n# Body\nkeep me\n";
    const set = setFrontmatter(content, { title: "New" });
    expect(parseFrontmatter(set)!.data.title).toBe("New");
    expect(parseFrontmatter(set)!.body).toBe("\n# Body\nkeep me\n");
    const merged = mergeFrontmatter(set, { tags: ["b", "c"] });
    expect(parseFrontmatter(merged)!.data.tags).toEqual(["a", "b", "c"]);
    expect(mergeFrontmatter(merged, { tags: ["c"] })).toBe(merged);
    const fresh = setFrontmatter("no header here\n", { k: "v" });
    expect(parseFrontmatter(fresh)!.data.k).toBe("v");
    expect(parseFrontmatter(fresh)!.body).toBe("no header here\n");
  });
});
