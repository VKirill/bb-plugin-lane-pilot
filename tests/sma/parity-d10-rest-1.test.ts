import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
import { ownerWaitingRpc } from "../../src/rooms/owner-waiting/server/rpc";
import { postOwnerItem } from "../../src/rooms/owner-waiting";
import { savePushConfig } from "../../src/rooms/owner-waiting/push";
import { saveProjectSetting } from "../../src/rooms/storage";
import { EVENT_FIELDS, postEvent } from "../../src/rooms/relay/server/outbound";
import { createRollback } from "../../src/rooms/rollback/server/rollback";
import { upsertAttemptChange } from "../../src/rooms/rollback/store";
import { createTask } from "../../src/rooms/plugin-db";
import { EXAM_DRAFTS_KEY, EXAM_SETTLED_KEY, mineDecisions, settleDraft } from "../../src/rooms/policy/mine";
import { loadLiveExam } from "../../src/rooms/policy/live-exam";
import { buildAcceptanceCard } from "../../src/rooms/acceptance/card";
import { closeOwnerItem } from "../../src/rooms/owner-waiting";
import { taskWordItemPrefix } from "../../src/rooms/contracts";
import { taskFamily } from "@lane-pilot/contracts";
import { BB_AGENT_SESSIONS } from "../../src/rooms/native-agent/native-agent-overlay";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { runCommandOnHost } from "../../src/rooms/writer/cli-run";
import { migrations } from "../../src/rooms/plugin-db";
import { savePrototypeConfig } from "../../src/rooms/storage";
import { backlogRpc } from "../../src/rooms/backlog/server";

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

  it("[sma:m_green] the pool walk is cached for a minute across status calls", async () => {
    let walks = 0;
    const canary = createCanary(ctx(), undefined, async () => { walks += 1; return { enabled: 1, blocked: [] }; });
    const t = Date.now();
    await canary.status(t);
    await canary.status(t + 30_000);
    expect(walks).toBe(1);
    await canary.status(t + 61_000);
    expect(walks).toBe(2);
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

  /** A reconcile over a fake host whose threads answer `status`; attempts are cancel_requested for two minutes unless said. */
  function confirmFixture(statusOf: () => string) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    const stops: string[] = [];
    const c = {
      acceptedTaskWorkspace: () => ({}), configForRun: async () => null, refreshRun: () => undefined,
      isDisposed: () => false, log: () => undefined, db,
      bb: { ...bb, log: { warn: () => undefined, info: () => undefined },
        sdk: { ...bb.sdk, threads: { stop: async (args: { threadId: string }) => { stops.push(args.threadId); return {}; },
          get: async () => ({ status: statusOf() }), listRunning: async () => [] } },
        storage: { kv: { get: async () => null, set: async () => undefined } } },
    } as never;
    const reconcile = createReconcile(c, { resumeDispatch: async () => ({ resumed: false, why: "test" }), rollback: { noteStopped: async () => ({ recorded: false }) }, startWriterTask: () => undefined } as never);
    const cancel = (attemptId: string, taskId: string, threadId: string, ageMs = 120_000) => {
      createAttempt(db, { id: attemptId, runId: "run", taskId });
      db.prepare("UPDATE lane_pilot_attempt SET state='cancel_requested', thread_id=?, updated_at=? WHERE id=?").run(threadId, Date.now() - ageMs, attemptId);
    };
    return { db, reconcile, stops, cancel };
  }

  it("[sma:m_confirm_later] a cancel whose stop was unseen is ended by the next re-check once the thread is idle, and stays open while it is active", async () => {
    let status = "active";
    const { db, reconcile, stops, cancel } = confirmFixture(() => status);
    cancel("att-1", "task-1", "thr-1");
    expect(await reconcile.recheckCancels()).toEqual([]);
    expect(getAttempt(db, "att-1")!.state).toBe("cancel_requested");
    status = "idle";
    expect(await reconcile.recheckCancels()).toEqual(["att-1"]);
    expect(getAttempt(db, "att-1")!.state).toBe("canceled");
    expect(stops.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("[sma:m_confirm_later] a writer thread a later attempt reuses is never stopped by the re-check of an older cancel", async () => {
    const { db, reconcile, stops, cancel } = confirmFixture(() => "idle");
    cancel("att-old", "task-1", "thr-shared");
    // The same task's next attempt carries on in the same writer thread (a feedback turn).
    createAttempt(db, { id: "att-new", runId: "run", taskId: "task-1" });
    db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr-shared', created_at=? WHERE id='att-new'").run(Date.now() + 1_000);
    expect(await reconcile.recheckCancels()).toEqual([]);
    expect(stops).toEqual([]);
    expect(getAttempt(db, "att-old")!.state).toBe("cancel_requested");
  });

  it("[sma:m_confirm_later] a cancel younger than the inline wait is left to it; at most three stuck cancels are tried per tick", async () => {
    const { db, reconcile, stops, cancel } = confirmFixture(() => "idle");
    cancel("young", "task-y", "thr-y", 5_000);
    for (const n of [1, 2, 3, 4, 5]) cancel(`old-${n}`, `task-${n}`, `thr-${n}`);
    const done = await reconcile.recheckCancels();
    expect(done).toHaveLength(3);
    expect(stops).toHaveLength(3);
    expect(stops).not.toContain("thr-y");
    expect(getAttempt(db, "young")!.state).toBe("cancel_requested");
  });

  it("[sma:rl_terms] an uncovered node without a term or the owner's word is a gap; with the term it is not", () => {
    const row = { kind: "mechanism" as const, id: "tools.demo", status: "none" as const, live: [], tests: [], note: "no drill runs it" };
    expect(untermedGaps([row])).toHaveLength(1);
    expect(untermedGaps([{ ...row, note: "no drill runs it; owner: later" }])).toHaveLength(0);
    expect(untermedGaps([{ ...row, note: "deferred: deferral:rl-42" }])).toHaveLength(0);
  });

  it("[sma:rl_terms] the command prints the untermed memory paths and exits as on main; --strict exits non-zero for them", () => {
    const untermed = untermedGaps(coverageRows()).map((row) => `${row.kind}:${row.id}`).sort();
    // Eight on main, three more from the wave's own exempt sites (the analysis' owner card, `memory load`, the parity report): none has a term yet.
    expect(untermed).toEqual(["memory_path:analyze.owner_card", "memory_path:cli.memory_load", "memory_path:cli.parity_report", "memory_path:hub.memory_import_eval", "memory_path:hub.session_rpc",
      "memory_path:maintainer.existing", "memory_path:memory.golden_eval", "memory_path:pm.cold", "memory_path:pm.contract", "memory_path:pm.owner_card", "memory_path:pm.replay_arm"]);
    // Nobody wrote the owner's word where the owner said nothing.
    expect(coverageRows().filter((row) => row.status === "none").every((row) => !/owner:/i.test(row.note) || untermed.every((id) => id !== `${row.kind}:${row.id}`))).toBe(true);
    const plain = runCoverageCli([]);
    expect(plain.exitCode).toBe(0);
    for (const id of untermed) expect(plain.stdout).toContain(id);
    expect(runCoverageCli(["--json"]).exitCode).toBe(0);
    expect(JSON.parse(runCoverageCli(["--json"]).stdout!).untermed).toEqual(expect.arrayContaining(untermed));
    const strict = runCoverageCli(["--json", "--strict"]);
    expect(strict.exitCode).toBe(1);
    expect(JSON.parse(strict.stdout!).gaps).toHaveLength(untermed.length);
    expect(runCoverageCli(["--strict"]).exitCode).toBe(1);
  });

  it("[sma:rl_terms] the drill's series preparation asks for the strict verdict", () => {
    expect(readFileSync(fileURLToPath(new URL("../../scripts/lp-drill.py", import.meta.url)), "utf8")).toContain('"coverage", "--json", "--strict"');
  });

  it("[sma:k_d_tpl_instructions] instructionForms gives the CLAUDE.md, Copilot and preferences forms, each pointing at PROJECT.md", () => {
    const forms = instructionForms({ name: "X", test: "npm test" });
    for (const body of [forms.claudeMd, forms.copilotInstructions, forms.preferences]) expect(body).toContain("PROJECT.md");
    expect(forms.claudeMd).toContain("# X");
    expect(forms.copilotInstructions).toContain("Copilot");
    expect(forms.preferences).toContain("npm test");
    expect(forms.preferences).toContain("Forbidden");
    // Nothing calls the function yet: the onboarder prompt does not name a function no agent can call.
    expect(BB_AGENT_SESSIONS["project-onboarder"]).not.toContain("instructionForms");
  });

  const ok = (edit: { content: string } | { refused: string }): string => { if ("refused" in edit) throw new Error(edit.refused); return edit.content; };
  const refused = (edit: { content: string } | { refused: string }): string => { if (!("refused" in edit)) throw new Error("expected a refusal"); return edit.refused; };

  it("[sma:k_t_frontmatter] set changes only the lines of its keys; every other header line and the body stay byte-identical", () => {
    const content = "---\ntitle: \"A: b\"\n# keep this comment\nowner: 'me'\ntags: [a, b]\n---\n\n# Body\nkeep me\n";
    const set = ok(setFrontmatter(content, { owner: "you" }));
    expect(set).toBe("---\ntitle: \"A: b\"\n# keep this comment\nowner: you\ntags: [a, b]\n---\n\n# Body\nkeep me\n");
    // A value that needs quotes is quoted; a new key goes before the closing ---.
    const added = ok(setFrontmatter(content, { note: "x: y" }));
    expect(added).toBe(content.replace("tags: [a, b]\n---", "tags: [a, b]\nnote: \"x: y\"\n---"));
    expect(parseFrontmatter(added)!.data.note).toBe("x: y");
    const merged = ok(mergeFrontmatter(set, { tags: ["b", "c"] }));
    expect(merged).toBe(set.replace("[a, b]", "[a, b, c]"));
    expect(ok(mergeFrontmatter(merged, { tags: ["c"] }))).toBe(merged);
    const fresh = ok(setFrontmatter("no header here\n", { k: "v" }));
    expect(fresh).toBe("---\nk: v\n---\nno header here\n");
  });

  it("[sma:k_t_frontmatter] a block list gets the new item appended in its own form", () => {
    const content = "---\ntags:\n  - a\n  - b\ntitle: T\n---\nbody\n";
    expect(ok(mergeFrontmatter(content, { tags: ["b", "c"] }))).toBe("---\ntags:\n  - a\n  - b\n  - c\ntitle: T\n---\nbody\n");
  });

  it("[sma:k_t_frontmatter] a block scalar, a key with nested lines, a value with a newline are refused with the reason", () => {
    const content = "---\ndescription: >\n  long text\n  more\nmeta:\n  a: 1\ntitle: T\n---\nbody\n";
    expect(refused(setFrontmatter(content, { description: "x" }))).toMatch(/block scalar or has nested/);
    expect(refused(setFrontmatter(content, { meta: "x" }))).toMatch(/block scalar or has nested/);
    expect(refused(mergeFrontmatter(content, { meta: ["x"] }))).toMatch(/nested/);
    expect(refused(setFrontmatter(content, { title: "two\nlines" }))).toMatch(/line break/);
    // A refused edit on one key writes nothing for the others: the answer is the refusal, not a half-edited text.
    expect(setFrontmatter(content, { title: "N", description: "x" })).toHaveProperty("refused");
    expect(ok(setFrontmatter(content, { title: "N" }))).toBe(content.replace("title: T", "title: N"));
  });

  it("[sma:k_t_frontmatter] a CRLF file keeps its line breaks: only the set line changes, no second header", () => {
    const content = "---\r\ntitle: Old\r\n# note\r\ntags: [a]\r\n---\r\n\r\nbody\r\n";
    expect(ok(setFrontmatter(content, { title: "New" }))).toBe(content.replace("Old", "New"));
    expect(ok(setFrontmatter(content, { extra: "1.0" }))).toBe(content.replace("tags: [a]\r\n", "tags: [a]\r\nextra: \"1.0\"\r\n"));
    expect(ok(mergeFrontmatter(content, { tags: ["b"] }))).toBe(content.replace("[a]", "[a, b]"));
    expect(ok(setFrontmatter("plain\r\ntext\r\n", { k: "v" }))).toBe("---\r\nk: v\r\n---\r\nplain\r\ntext\r\n");
  });

  it("[sma:k_t_frontmatter] the CLI verb writes the header of a real file, keeps the rest, refuses a changed or linked file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-frontmatter-"));
    const file = join(dir, "page one.md");
    const original = "---\ntitle: \"A: b\"\n# why\ntags: [x]\n---\n\n# Body\n";
    writeFileSync(file, original);
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "p1", hostId: "h", pmWorkspacePath: dir, writerWorkspacePath: dir, pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "m" } as never);
    const core = createCore(bb, db) as unknown as { host: unknown };
    let tamper: string | null = null;
    core.host = { call: async (_method: string, input: Parameters<typeof runCommandOnHost>[0]) => {
      if (tamper && input.command.includes("base64 -d")) { writeFileSync(tamper, "someone else wrote this\n"); tamper = null; }
      return runCommandOnHost(input);
    } };
    registerCli(core as never, {} as never, migrations);
    const run = (...args: string[]) => harness.behavior.runCli(["frontmatter", "p1", ...args]);
    const wrote = await run("page one.md", "--set", "status=done", "--merge", "tags=y,x");
    expect(wrote.stderr ?? "").toBe("");
    expect(wrote.exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("---\ntitle: \"A: b\"\n# why\ntags: [x, y]\nstatus: done\n---\n\n# Body\n");
    expect(JSON.parse((await run("page one.md")).stdout!)).toMatchObject({ title: "A: b", status: "done" });
    // A path outside the checkout, a linked file and a refused edit write nothing.
    expect((await run("../x.md", "--set", "a=b")).exitCode).toBe(1);
    symlinkSync(file, join(dir, "link.md"));
    const before = readFileSync(file, "utf8");
    const linked = await run("link.md", "--set", "a=b");
    expect(linked.exitCode).toBe(1);
    writeFileSync(join(dir, "block.md"), "---\nd: |\n  x\n---\n");
    const block = await run("block.md", "--set", "d=y");
    expect(block.exitCode).toBe(1);
    expect(block.stderr).toMatch(/block scalar/);
    expect(readFileSync(join(dir, "block.md"), "utf8")).toBe("---\nd: |\n  x\n---\n");
    expect(readFileSync(file, "utf8")).toBe(before);
    // A file changed between the read and the write is refused and left as the other writer left it.
    tamper = file;
    const raced = await run("page one.md", "--set", "status=again");
    expect(raced.exitCode).toBe(1);
    expect(raced.stderr).toMatch(/changed under the read/);
    expect(readFileSync(file, "utf8")).toBe("someone else wrote this\n");
  });

  it("[sma:k_lib_notify] an unset webhook posts nothing; a named one gets owner.waiting per new wake key and one pulse, each with the nine fields", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePushConfig(db, { enabled: "on", quiet: "00:00-00:00" });
    saveProjectSetting(db, "proj", "events.webhook_url", "https://hook.example/x");
    postOwnerItem(db, { key: "night:w1", source: "night", kind: "wall", projectId: "proj", what: "Wall stuck", why: "The loop stopped", wake: true }, Date.now());
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { body?: string }) => { posts.push({ url: String(url), body: JSON.parse(init.body ?? "{}") }); return { ok: true } as never; }) as never;
    try {
      const rpc = ownerWaitingRpc(db, [], undefined, undefined, postEvent);
      // First pass: one owner.waiting for the new key and one pulse.
      const digest = await rpc.owner_waiting_digest();
      // A pass over acknowledged keys posts nothing more for them.
      await rpc.owner_waiting_ack({ keys: digest.keys });
      await rpc.owner_waiting_digest();
    } finally { globalThis.fetch = realFetch; }
    const waiting = posts.filter((post) => post.body.event === "owner.waiting");
    expect(waiting).toHaveLength(1);
    expect(Object.keys(waiting[0]!.body).sort()).toEqual([...EVENT_FIELDS].sort());
    expect(waiting[0]!.body).toMatchObject({ projectId: "proj", kind: "wall", state: "waiting", runId: "night", taskId: "night:w1" });
    // No owner-item text leaves the machine: neither `what` nor `why`, whatever field they could ride in.
    expect(JSON.stringify(waiting[0]!.body)).not.toMatch(/Wall stuck|loop stopped/);
    expect(waiting[0]!.body.title).toBe("Work is blocked and waits for the owner");
    expect(posts.filter((post) => post.body.event === "pulse")).toHaveLength(1);
    // With no webhook the pass is silent.
    const { bb: bb2 } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db2 = openDatabase(bb2);
    savePushConfig(db2, { enabled: "on", quiet: "00:00-00:00" });
    postOwnerItem(db2, { key: "night:w2", source: "night", kind: "wall", projectId: "proj", what: "No hook", why: "silent", wake: true }, Date.now());
    const posts2: unknown[] = [];
    globalThis.fetch = (async () => { posts2.push(1); return { ok: true } as never; }) as never;
    try { await ownerWaitingRpc(db2, [], undefined, undefined, postEvent).owner_waiting_digest(); } finally { globalThis.fetch = realFetch; }
    expect(posts2).toHaveLength(0);
  });

  it("[sma:k_lib_notify] a throwing or hanging webhook never delays or fails the digest or the owner-item write", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePushConfig(db, { enabled: "on", quiet: "00:00-00:00" });
    saveProjectSetting(db, "proj", "events.webhook_url", "https://hook.example/x");
    const logs: string[] = [];
    const realFetch = globalThis.fetch;
    try {
      for (const behaviour of ["throws", "hangs"] as const) {
        globalThis.fetch = (behaviour === "throws" ? async () => { throw new Error("boom"); } : () => new Promise(() => undefined)) as never;
        const key = `night:${behaviour}`;
        const started = Date.now();
        postOwnerItem(db, { key, source: "night", kind: "wall", projectId: "proj", what: "W", why: "w", wake: true }, Date.now());
        const digest = await ownerWaitingRpc(db, [], undefined, (message) => logs.push(message), postEvent).owner_waiting_digest();
        expect(digest.keys).toContain(key);
        expect(Date.now() - started).toBeLessThan(2_000);
      }
      // A poster that rejects is logged, not an unhandled rejection.
      postOwnerItem(db, { key: "night:rejects", source: "night", kind: "wall", projectId: "proj", what: "W", why: "w", wake: true }, Date.now());
      await ownerWaitingRpc(db, [], undefined, (message) => logs.push(message), async () => { throw new Error("poster failed"); }).owner_waiting_digest();
      await new Promise((wake) => setTimeout(wake, 20));
    } finally { globalThis.fetch = realFetch; }
    expect(logs.some((line) => line.includes("poster failed"))).toBe(true);
  });

  it("[sma:d_diff] task_diff shows the merge commit's patch through the host, clipped with a mark, or names the reason", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo", "none", undefined, "hub");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: {
      schema_version: 2, id: "t1", title: "t", risk: "low", lane: "server", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
      expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: "t1", acceptance: ["done"], verify: "tests", verification: [],
    } });
    createAttempt(db, { id: "att-1", runId: "run", taskId: "t1" });
    upsertAttemptChange(db, { attemptId: "att-1", runId: "run", taskId: "t1" }, { outcome: "merged", mergeCommit: "a".repeat(40), mergeParent: "b".repeat(40), changed: [] });
    const commands: string[] = [];
    const rollback = createRollback({
      db, log: () => undefined, isDisposed: () => false,
      configForRun: async () => ({ hostId: "hub", projectId: "proj" }),
      host: { call: async (method: string, input: { command?: string }) => { commands.push(input.command ?? ""); return { exitCode: 0, stdout: "x".repeat(70_000) }; } },
    } as never, {} as never);
    const answer = await rollback.rollback.diff("att-1") as { patch: string; truncated: boolean };
    expect(commands[0]).toContain(`git show --patch --stat --format= ${"a".repeat(40)} | head -c 60001`);
    expect(answer.truncated).toBe(true);
    expect(answer.patch).toContain("показано начало");
    expect(answer.patch.length).toBeLessThan(70_000);
    createAttempt(db, { id: "att-2", runId: "run", taskId: "t1" });
    const none = await rollback.rollback.diff("att-2") as { reason: string };
    expect(none.reason).toContain("no merge commit");
  });

  it("[sma:k_v_decisions] mined decisions wait as drafts; mining twice never doubles, and only an accept joins the exam", async () => {
    const kv = new Map<string, unknown>();
    const store = { get: async <T>(key: string) => (kv.get(key) as T) ?? null, set: async (key: string, value: never) => { kv.set(key, value); } };
    const judge = async (message: { text: string }) => /deploy/i.test(message.text)
      ? { decision: "approve" as const, descriptor: { kind: "deploy" }, expected: "owner_only" as const, why: "approved a deploy" } : null;
    const messages = [
      { id: "m1", at: 1, text: "да, deploy it now" },
      { id: "m2", at: 2, text: "how is the weather" },
    ];
    expect(await mineDecisions(store, messages, judge)).toMatchObject({ mined: 1, total: 1 });
    expect(await mineDecisions(store, messages, judge)).toMatchObject({ mined: 0, total: 1 });
    const exam = await loadLiveExam(store);
    expect(exam.items).toHaveLength(0);
    const draftId = (kv.get(EXAM_DRAFTS_KEY) as Array<{ id: string }>)[0]!.id;
    const settled = await settleDraft(store, draftId, "accept");
    expect(settled.ok).toBe(true);
    expect((await loadLiveExam(store)).items).toHaveLength(1);
    expect(await settleDraft(store, draftId, "accept")).toMatchObject({ ok: false });
    // Mining the same window again does not bring the accepted draft back.
    expect(await mineDecisions(store, messages, judge)).toMatchObject({ mined: 0, total: 0 });
  });

  it("[sma:k_v_decisions] a dismissed draft does not come back when the same window is mined again; the lists stay bounded", async () => {
    const kv = new Map<string, unknown>();
    const store = { get: async <T>(key: string) => (kv.get(key) as T) ?? null, set: async (key: string, value: never) => { kv.set(key, value); } };
    const judge = async () => ({ decision: "approve" as const, descriptor: { kind: "deploy" }, expected: "owner_only" as const, why: "approved" });
    const messages = [{ id: "m1", at: 1, text: "да, deploy it" }];
    await mineDecisions(store, messages, judge);
    const id = (kv.get(EXAM_DRAFTS_KEY) as Array<{ id: string }>)[0]!.id;
    expect(await settleDraft(store, id, "dismiss")).toEqual({ ok: true });
    expect(await mineDecisions(store, messages, judge)).toMatchObject({ mined: 0, total: 0 });
    expect((kv.get(EXAM_DRAFTS_KEY) as unknown[])).toHaveLength(0);
    expect(kv.get(EXAM_SETTLED_KEY)).toEqual([id]);
    // 250 drafts keep the newest 200; 600 settled ids keep the newest 500.
    const many = Array.from({ length: 250 }, (_, n) => ({ id: `m${n + 10}`, at: n, text: `да, deploy ${n}` }));
    expect(await mineDecisions(store, many, judge)).toMatchObject({ mined: 250, total: 200 });
    const drafts = kv.get(EXAM_DRAFTS_KEY) as Array<{ id: string; ref: string }>;
    expect(drafts).toHaveLength(200);
    expect(drafts[199]!.ref).toBe("m259");
    for (const draft of drafts) await settleDraft(store, draft.id, "dismiss");
    kv.set(EXAM_SETTLED_KEY, Array.from({ length: 499 }, (_, n) => `old${n}`));
    await mineDecisions(store, [{ id: "z1", at: 1, text: "да, deploy z1" }, { id: "z2", at: 2, text: "да, deploy z2" }], judge);
    const last = (kv.get(EXAM_DRAFTS_KEY) as Array<{ id: string }>);
    for (const draft of last) await settleDraft(store, draft.id, "dismiss");
    const settledIds = kv.get(EXAM_SETTLED_KEY) as string[];
    expect(settledIds).toHaveLength(500);
    expect(settledIds[499]).toBe(last[last.length - 1]!.id);
  });

  it("[sma:sc_acceptance] an open task_word item on the task's family answers awaitsWord true; the owner's word closes it", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    const contract = { project_cwd: "/repo", title: "t" };
    createTask(db, { id: "task-1", runId: "run", kind: "bb", contract });
    expect(buildAcceptanceCard(db, { runId: "run", taskId: "task-1" })!.awaitsWord).toBe(false);
    postOwnerItem(db, { key: `${taskWordItemPrefix("run", taskFamily("task-1"))}att-1`, source: "writer", kind: "task_word", projectId: "proj", what: "Слить?", why: "acceptance" }, Date.now());
    expect(buildAcceptanceCard(db, { runId: "run", taskId: "task-1" })!.awaitsWord).toBe(true);
    closeOwnerItem(db, `${taskWordItemPrefix("run", taskFamily("task-1"))}att-1`, "screen");
    expect(buildAcceptanceCard(db, { runId: "run", taskId: "task-1" })!.awaitsWord).toBe(false);
  });

  it("[sma:m_sw_backlog] the backlog_board RPC answers the scanner's four-lane board for the screen", async () => {
    const item = { id: "t-1", title: "Job", status: "ready", priority: "high", estimate: 3, dependsOn: [], created: "2026-01-01" };
    const rpc = backlogRpc({ board: async () => ({ issuable: [item], needsEstimate: [], decompose: [], blocked: [] }), issue: async () => ({ ok: true, pmThreadId: "thr" }) } as never);
    const board = await rpc.backlog_board({ projectId: "P" }) as { issuable: Array<{ id: string }> };
    expect(board.issuable.map((row) => row.id)).toEqual(["t-1"]);
  });
});
