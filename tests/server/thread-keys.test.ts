import { describe, expect, it } from "vitest";
import { reconcile, reconcileHolder } from "../../src/rooms/stability/reconcile";
import { fullAccessSpawn } from "../../src/server/pm-spawn";
import { clearSpawnMarker, findThreadsByMetadata, spawnIdentity, spawnKey, spawnTextId } from "../../src/server/thread-keys";

type Row = { id: string; key: string | null; metadata: Record<string, unknown>; archived: boolean };

/** A core with the VK thread keys: a keyed spawn holds its key; `loseAnswers` makes the next spawns create the thread and then fail. */
function keyedBb(options: { loseAnswers?: number; noFind?: boolean } = {}) {
  const rows: Row[] = [];
  const kv = new Map<string, unknown>();
  let lose = options.loseAnswers ?? 0;
  let plainSpawns = 0;
  let lists = 0;
  const create = (args: Record<string, unknown>, key: string | null) => {
    const row: Row = { id: `thr_${rows.length + 1}`, key, metadata: { ...(args.pluginMetadata as Record<string, unknown>) }, archived: false };
    rows.push(row);
    return { id: row.id };
  };
  const threads: Record<string, unknown> = {
    spawn: async (args: Record<string, unknown>) => { plainSpawns += 1; return create(args, null); },
    list: async () => { lists += 1; return rows.map((row) => ({ id: row.id })); },
    getPluginMetadata: async ({ threadId }: { threadId: string }) => rows.find((row) => row.id === threadId)?.metadata ?? {},
    experimental_vkSpawnKeyed: async ({ key, ...args }: { key: string } & Record<string, unknown>) => {
      const held = rows.find((row) => row.key === key);
      if (held) return { thread: { id: held.id }, reused: true };
      const thread = create(args, key);
      if (lose > 0) { lose -= 1; throw new Error("answer lost"); }
      return { thread, reused: false };
    },
    experimental_vkFindByKey: options.noFind ? undefined : async (key: string) => { const held = rows.find((row) => row.key === key); return held ? { id: held.id } : null; },
    experimental_vkFindByPluginMetadata: async ({ match }: { match: Record<string, unknown> }) =>
      rows.filter((row) => !row.archived && Object.entries(match).every(([name, value]) => row.metadata[name] === value)).map((row) => ({ id: row.id })),
  };
  const bb = { vk: {}, sdk: { threads }, storage: { kv: {
    get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => { kv.set(key, value); }, delete: async (key: string) => { kv.delete(key); },
  } } } as never;
  return { bb, rows, kv, stats: () => ({ plainSpawns, lists }) };
}
const writer = (attemptId: string) => ({ projectId: "p", prompt: "x", pluginMetadata: { role: "writer", lanePilotRunId: "run", lanePilotTaskId: "task", attemptId } }) as never;

describe("keyed spawn of Lane Pilot threads", () => {
  it("names a spawn by its owner, role and number", () => {
    expect(spawnIdentity({ role: "writer", attemptId: "att1" })).toEqual({ stable: "att1", role: "writer" });
    expect(spawnIdentity({ role: "workspace-provisioner", workspaceAttemptId: "att1" })).toEqual({ stable: "att1", role: "workspace-provisioner" });
    expect(spawnIdentity({ role: "code-critic", lanePilotRunId: "r", lanePilotTaskId: "t", stageId: "code-critique" })).toEqual({ stable: "r:t:code-critique", role: "code-critic" });
    expect(spawnIdentity({ role: "specialist", lanePilotRunId: "r" })).toBeNull();
    expect(spawnKey("att1", "writer", 2)).toBe("lp:att1:writer:2");
    expect(spawnKey("x".repeat(300), "writer", 1).length).toBeLessThanOrEqual(200);
  });

  it("spawn answer lost: the same call repeated returns the same thread", async () => {
    const core = keyedBb({ loseAnswers: 1, noFind: true });
    await expect(fullAccessSpawn(core.bb, writer("att1"))).rejects.toThrow("answer lost");
    expect(core.rows).toHaveLength(1);
    expect(core.kv.has("spawn-key:att1:writer")).toBe(true);
    await expect(fullAccessSpawn(core.bb, writer("att1"))).resolves.toMatchObject({ id: "thr_1" });
    expect(core.rows).toHaveLength(1);
    expect(core.rows[0]!.key).toBe("lp:att1:writer:1");
    expect(core.kv.size).toBe(0);
  });

  it("spawn answer lost: the helper asks the core for the key before it fails", async () => {
    const core = keyedBb({ loseAnswers: 1 });
    await expect(fullAccessSpawn(core.bb, writer("att1"))).resolves.toMatchObject({ id: "thr_1" });
    expect(core.rows).toHaveLength(1);
    expect(core.stats().plainSpawns).toBe(0);
  });

  it("a second spawn of the same owner after the first finished is a new thread", async () => {
    const core = keyedBb();
    await fullAccessSpawn(core.bb, writer("att1"));
    await fullAccessSpawn(core.bb, writer("att1"));
    expect(core.rows.map((row) => row.key)).toEqual(["lp:att1:writer:1", "lp:att1:writer:2"]);
  });

  it("a spawn without an owner still gets a key and never merges two helpers", async () => {
    const core = keyedBb();
    const helper = { projectId: "p", prompt: "x", pluginMetadata: { role: "specialist", lanePilotRunId: "run" } } as never;
    await fullAccessSpawn(core.bb, helper);
    await fullAccessSpawn(core.bb, helper);
    expect(core.rows).toHaveLength(2);
    expect(core.rows.every((row) => row.key?.startsWith("lp:") && row.key.endsWith(":specialist:1"))).toBe(true);
  });

  it("a helper that names its spawn with spawnId gets a stable key: a lost answer repeated is the same thread", async () => {
    const core = keyedBb({ loseAnswers: 1, noFind: true });
    const specialist = { projectId: "p", prompt: "x", pluginMetadata: { role: "specialist", lanePilotRunId: "run", spawnId: `run:seo:${spawnTextId("audit the page")}` } } as never;
    expect(spawnIdentity((specialist as { pluginMetadata: Record<string, unknown> }).pluginMetadata)).toEqual({ stable: `run:seo:${spawnTextId("audit the page")}`, role: "specialist" });
    await expect(fullAccessSpawn(core.bb, specialist)).rejects.toThrow("answer lost");
    await expect(fullAccessSpawn(core.bb, specialist)).resolves.toMatchObject({ id: "thr_1" });
    expect(core.rows).toHaveLength(1);
    expect(core.rows[0]!.key).toMatch(/^lp:run:seo:[0-9a-f]{16}:specialist:1$/);
    // The same task asked for again after that one finished is a new specialist.
    await fullAccessSpawn(core.bb, specialist);
    expect(core.rows).toHaveLength(2);
    expect(core.rows[1]!.key).toMatch(/:specialist:2$/);
  });

  it("a council seat of another round is another thread", async () => {
    const core = keyedBb({ noFind: true });
    const seat = (round: number) => ({ projectId: "p", prompt: "x", pluginMetadata: { role: "council-seat", lanePilotRunId: "run", spawnId: `council1:seatA:r${round}` } }) as never;
    await fullAccessSpawn(core.bb, seat(1));
    await fullAccessSpawn(core.bb, seat(2));
    expect(core.rows.map((row) => row.key)).toEqual(["lp:council1:seatA:r1:council-seat:1", "lp:council1:seatA:r2:council-seat:1"]);
  });

  it("a thread adopted through reconcile is not handed to the next round of the same identity", async () => {
    const core = keyedBb({ loseAnswers: 1, noFind: true });
    const critic = { role: "code-critic", lanePilotRunId: "run", lanePilotTaskId: "task", stageId: "code-critique" };
    await expect(fullAccessSpawn(core.bb, { projectId: "p", prompt: "round 1", pluginMetadata: critic } as never)).rejects.toThrow("answer lost");
    // Round 1 is settled by reconcile (the thread was found), not by the spawn answer.
    await clearSpawnMarker(core.bb, critic);
    expect(core.kv.size).toBe(0);
    await expect(fullAccessSpawn(core.bb, { projectId: "p", prompt: "round 2", pluginMetadata: critic } as never)).resolves.toMatchObject({ id: "thr_2" });
    expect(core.rows.map((row) => row.key)).toEqual(["lp:run:task:code-critique:code-critic:1", "lp:run:task:code-critique:code-critic:2"]);
  });

  it("without the marker cleared, the next round would have read the lost round's thread (what clearSpawnMarker prevents)", async () => {
    const core = keyedBb({ loseAnswers: 1, noFind: true });
    const critic = { role: "code-critic", lanePilotRunId: "run", lanePilotTaskId: "task", stageId: "code-critique" };
    await expect(fullAccessSpawn(core.bb, { projectId: "p", prompt: "round 1", pluginMetadata: critic } as never)).rejects.toThrow();
    await expect(fullAccessSpawn(core.bb, { projectId: "p", prompt: "round 2", pluginMetadata: critic } as never)).resolves.toMatchObject({ id: "thr_1" });
  });

  it("a test host that answers every sdk path is not a VK build", async () => {
    const calls: string[] = [];
    const answers = new Proxy(function () {}, { get: (_t, name) => typeof name === "string" && name !== "then" ? (() => { calls.push(name); throw new Error("not stubbed"); }) : undefined });
    const bb = { sdk: { threads: { spawn: async () => ({ id: "t" }), experimental_vkSpawnKeyed: answers, experimental_vkFindByPluginMetadata: answers } } } as never;
    await expect(fullAccessSpawn(bb, writer("att1"))).resolves.toMatchObject({ id: "t" });
    await expect(findThreadsByMetadata(bb, { a: "b" })).resolves.toBeNull();
  });

  it("without the core functions it is the plain spawn", async () => {
    const plain: Row[] = [];
    const bb = { sdk: { threads: { spawn: async (args: Record<string, unknown>) => { plain.push({ id: "t", key: null, metadata: {}, archived: false }); return { id: "t", args }; } } },
      storage: { kv: { get: async () => { throw new Error("kv untouched"); } } } } as never;
    await expect(fullAccessSpawn(bb, writer("att1"))).resolves.toMatchObject({ id: "t" });
    expect(plain).toHaveLength(1);
  });
});

describe("reconcile through the metadata lookup", () => {
  const port = (core: ReturnType<typeof keyedBb>) => {
    const threads = (core.bb as { sdk: { threads: Record<string, (...args: unknown[]) => Promise<never>> } }).sdk.threads;
    return {
      list: async ({ limit, offset }: { limit: number; offset: number }) => (await threads.list!() as unknown as Array<{ id: string }>).slice(offset, offset + limit),
      metadata: async (threadId: string) => threads.getPluginMetadata!({ threadId }) as unknown as Record<string, unknown>,
      find: (match: Record<string, string>) => findThreadsByMetadata(core.bb, match, "p"),
    };
  };
  const triple = { lanePilotRunId: "run", lanePilotTaskId: "task", attemptId: "att1" };

  it("finds the thread, reports none and flags two without paging the project", async () => {
    const core = keyedBb();
    await expect(reconcile(port(core), triple)).resolves.toEqual({ kind: "not_found" });
    await fullAccessSpawn(core.bb, writer("att1"));
    await expect(reconcile(port(core), triple)).resolves.toEqual({ kind: "found", threadId: "thr_1" });
    await fullAccessSpawn(core.bb, writer("att1"));
    await expect(reconcile(port(core), triple)).resolves.toEqual({ kind: "blocked", reason: "ambiguous" });
    expect(core.stats().lists).toBe(0);
  });

  it("finds a holder by role and workspace attempt", async () => {
    const core = keyedBb();
    await fullAccessSpawn(core.bb, { projectId: "p", prompt: "x", pluginMetadata: { role: "workspace-provisioner", lanePilotRunId: "run", lanePilotTaskId: "task", workspaceAttemptId: "att1" } } as never);
    await expect(reconcileHolder(port(core), { lanePilotRunId: "run", lanePilotTaskId: "task", workspaceAttemptId: "att1" })).resolves.toEqual({ kind: "found", threadId: "thr_1" });
  });

  it("falls back to the list scan without the function or on its failure", async () => {
    const core = keyedBb();
    await fullAccessSpawn(core.bb, writer("att1"));
    const noFind = { ...port(core), find: async () => null };
    await expect(reconcile(noFind, triple)).resolves.toEqual({ kind: "found", threadId: "thr_1" });
    const broken = { ...port(core), find: async () => { throw new Error("boom"); } };
    await expect(reconcile(broken, triple)).resolves.toEqual({ kind: "found", threadId: "thr_1" });
    expect(core.stats().lists).toBe(2);
  });

  it("a full page of matches is left to the list scan", async () => {
    const core = keyedBb();
    const threads = (core.bb as { sdk: { threads: Record<string, unknown> } }).sdk.threads;
    threads.experimental_vkFindByPluginMetadata = async () => Array.from({ length: 100 }, (_, index) => ({ id: `t${index}` }));
    await expect(findThreadsByMetadata(core.bb, { a: "b" })).resolves.toBeNull();
  });
});
