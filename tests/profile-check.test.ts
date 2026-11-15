import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  buildProfileReport,
  latestProfileCheck,
  narrowedByCeiling,
  profileCheckMorningLine,
  rolePolicyCounts,
  saveProfileCheck,
} from "../src/rooms/native-agent";
import { helperThreadsViaSdk } from "../src/rooms/native-agent/profile-check";
import { coreRequiredSessionAdvertisement, type RequiredSessionAdvertisement } from "../src/rooms/contracts/helper-context";
import { createProfileCheck, PROFILE_CHECK_OWNER_KEY } from "../src/rooms/native-agent/server/profile-check";
import { openDatabase } from "../src/rooms/plugin-db";

const NOW = Date.UTC(2026, 10, 6, 9, 0, 0);
const HOUR = 3_600_000;

type FixtureThread = { id: string; role?: string; at?: number; probe?: boolean; bench?: boolean; parent?: string | null; policy?: object | null; inspect?: unknown };

type ListArgs = { limit?: number; offset?: number; hasParent?: boolean; originPluginId?: string };
type MetaArgs = { pluginId?: string; threadIds: string[] };

function listPage(threads: FixtureThread[], args: ListArgs) {
  // The API applies originPluginId + hasParent server-side; the stub honours the same contract.
  const pool = threads.filter((t) => (t.parent === undefined ? true : t.parent !== null));
  return pool.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200)).map((t) => ({ id: t.id, createdAt: t.at ?? NOW - HOUR, parentThreadId: t.parent === null ? null : "thr_parent" }));
}

function metaPage(threads: FixtureThread[], args: MetaArgs) {
  if (args.pluginId !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(args.pluginId)) {
    throw new Error(`invalid pluginId: ${args.pluginId}`);
  }
  return { threads: args.threadIds.flatMap((id) => {
    const t = threads.find((x) => x.id === id);
    if (!t) return [];
    const metadata = { ...(t.role ? { role: t.role } : {}), ...(t.probe ? { helperProbe: true } : {}), ...(t.bench ? { lanePilotBench: true } : {}) };
    return metadata && Object.keys(metadata).length ? [{ threadId: id, metadata }] : [];
  }) };
}

/** The SDK surface the check reads: `threads.list` for this plugin's hidden child helpers, `experimental_listPluginMetadata` for the lane-pilot role/markers. `pluginId` is validated at the boundary exactly like the core's pluginIdSchema (`^[a-z0-9][a-z0-9-]*$`) so a reserved namespace can never pass as a fakehost positive (SDK-UP01). */
function sdkThreads(harness: ReturnType<typeof createFakePluginHost>["harness"], threads: FixtureThread[], seen?: { listArgs: unknown[]; metaCalls?: { pluginId?: string; size: number }[] }) {
  harness.sdk.stub("threads.list" as never, async (args: ListArgs) => {
    seen?.listArgs.push(args);
    return listPage(threads, args);
  });
  harness.sdk.stub("threads.experimental_listPluginMetadata" as never, async (args: MetaArgs) => {
    seen?.metaCalls?.push({ ...(args.pluginId ? { pluginId: args.pluginId } : {}), size: args.threadIds.length });
    return metaPage(threads, args);
  });
}

/**
 * The optional VK P2 inspection, stubbed on the fake host. `t.policy` (a `{version:1, policy}` snapshot) answers
 * `valid`; `t.inspect` overrides the whole result entry (invalid/unavailable/custom); anything else is `absent`.
 * `respond` replaces the whole reply for malformed-shape tests.
 */
function sdkInspect(
  harness: ReturnType<typeof createFakePluginHost>["harness"],
  threads: FixtureThread[],
  opts?: {
    respond?: (ids: string[]) => unknown;
    seen?: { calls: number[] };
  },
) {
  harness.sdk.stub("threads.experimental_vkInspectRequiredSessionPolicies" as never, async (args: { threadIds: string[] }) => {
    opts?.seen?.calls.push(args.threadIds.length);
    if (opts?.respond) return opts.respond(args.threadIds);
    return {
      version: 1,
      results: args.threadIds.map((id) => {
        const t = threads.find((x) => x.id === id);
        if (t?.inspect !== undefined) return t.inspect;
        if (t?.policy) return { threadId: id, status: "valid", snapshot: t.policy };
        return { threadId: id, status: "absent" };
      }),
    };
  });
}

/** A threads API with NO inspection method — the honest old-host shape the fake proxy cannot express (every path looks like a function). */
function threadsApiWithoutInspect(threads: FixtureThread[], seen?: { listArgs: unknown[]; metaCalls?: { pluginId?: string; size: number }[] }) {
  return {
    list: async (args: ListArgs) => {
      seen?.listArgs.push(args);
      return listPage(threads, args);
    },
    experimental_listPluginMetadata: async (args: MetaArgs) => {
      seen?.metaCalls?.push({ ...(args.pluginId ? { pluginId: args.pluginId } : {}), size: args.threadIds.length });
      return metaPage(threads, args);
    },
  };
}

/** A minimal bb for direct helperThreadsViaSdk calls on an old host. */
function bbWithoutInspect(threads: FixtureThread[], seen?: { listArgs: unknown[]; metaCalls?: { pluginId?: string; size: number }[] }) {
  return { sdk: { threads: threadsApiWithoutInspect(threads, seen) } } as never;
}

const policy = (over: { skills?: string[]; mcpServers?: string[]; bbPlugins?: string[] } = {}) => ({
  version: 1,
  policy: {
    bbPlugins: { mode: "allow", names: ["environment-project-checkout", "project-folders", ...(over.bbPlugins ?? [])], allOf: [] },
    skills: { mode: "allow", names: over.skills ?? [], allOf: [] },
    mcpServers: { mode: "allow", names: ["bb-bridge", ...(over.mcpServers ?? [])], allOf: [] },
    claudeAiSync: false,
  },
});

const agents = (advertised: RequiredSessionAdvertisement | null) =>
  advertised === null ? {} : { experimental_vkRequiredSessionPolicy: () => advertised };

/** A writer profile: skills lp-writer + karpathy-guidelines, mcpServers gitnexus + metamcp. */
const writerPolicy = () => policy({ skills: ["lp-writer", "karpathy-guidelines"], mcpServers: ["gitnexus", "metamcp"] });

/**
 * Producer contract corpus — hand-recorded from the frozen core producer, never imported at runtime.
 * Provenance: bb-core/vk @ c0c38bd49 — DTO `packages/plugin-sdk/src/vk-required-session-policy-inspection.ts`,
 * statuses `apps/server/src/services/plugins/vk-required-session-policy-inspection.ts`, value bounds and the
 * predicate `packages/domain/src/vk-session-policy.ts`. Until the npm SDK ships the method (its generated DTO
 * types then join the typecheck path), this fixture is the source-compared contract evidence: it proves the
 * consumer accepts/rejects the recorded shapes, not end-to-end real-host behavior.
 */
const PRODUCER_CORPUS = {
  // Distinct policy vs ceiling: policy is the stored session selection, ceiling the inherited bound — both valid,
  // and only `policy` may reach policyJson. Inside policy: an allOf deny clause and an empty allow list.
  validPolicyCeiling: {
    threadId: "w-ceiling",
    status: "valid",
    snapshot: {
      version: 1,
      policy: {
        bbPlugins: { mode: "allow", names: ["environment-project-checkout", "project-folders"], allOf: [] },
        skills: { mode: "allow", names: ["lp-writer"], allOf: [{ mode: "deny", names: ["internal-*"] }] },
        mcpServers: { mode: "allow", names: [], allOf: [] },
        claudeAiSync: false,
      },
      ceiling: {
        skills: { mode: "allow", names: ["lp-writer", "karpathy-guidelines"] },
        mcpServers: { mode: "allow", names: ["gitnexus", "bb-bridge"] },
      },
    },
  },
  // Trailing-* prefix allow + a deny naming a profile item; no ceiling at all — an absent ceiling stays valid.
  validPrefixDeny: {
    threadId: "w-prefix",
    status: "valid",
    snapshot: {
      version: 1,
      policy: {
        bbPlugins: { mode: "allow", names: ["project-*"], allOf: [] },
        skills: { mode: "allow", names: ["lp-*"], allOf: [] },
        mcpServers: { mode: "deny", names: ["gitnexus"] },
      },
    },
  },
  absent: { threadId: "w-absent", status: "absent" },
  invalidDigest: { threadId: "w-invalid", status: "invalid", reason: "digest_mismatch" },
  unavailable: { threadId: "w-unavailable", status: "unavailable" },
} as const;

function pluginDb() {
  const db = new Database(":memory:");
  db.exec("create table lane_pilot_profile_check (id integer primary key, at integer not null, report_json text not null)");
  return db;
}

describe("the profile check report", () => {
  it("all good: every helper carries a policy, capability required, provider rows match — green", () => {
    const report = buildProfileReport({
      threads: [
        { threadId: "w1", role: "writer", policyJson: JSON.stringify(writerPolicy()) },
        { threadId: "c1", role: "code-critic", policyJson: JSON.stringify(policy({ mcpServers: ["gitnexus"] })) },
        { threadId: "e1", role: "errand", policyJson: JSON.stringify(policy({ skills: ["browser-automation", "computer-use", "env-catalog"], bbPlugins: ["browser-automation", "env-catalog"] })) },
      ],
      agents: agents(coreRequiredSessionAdvertisement()),
      now: NOW,
    });
    expect(report.red).toEqual([]);
    expect(report.unverified).toBeNull();
    expect(report.requiredSessionPolicy).toBe("required");
    expect(report.providers.every((row) => row.ok)).toBe(true);
    expect(report.withPolicy).toBe(3);
    expect(report.noPolicy).toBe(0);
    expect(report.narrowed).toBe(0);
  });

  it("one helper without a policy: red naming the role", () => {
    const report = buildProfileReport({
      threads: [
        { threadId: "w1", role: "writer", policyJson: JSON.stringify(writerPolicy()) },
        { threadId: "w2", role: "writer", policyJson: null },
        { threadId: "p1", role: "pm-reader", policyJson: JSON.stringify(policy()) },
      ],
      agents: agents(coreRequiredSessionAdvertisement()),
      now: NOW,
    });
    expect(report.red.some((line) => line.includes("writer"))).toBe(true);
    expect(report.noPolicy).toBe(1);
    expect(report.roles.find((row) => row.role === "writer")).toMatchObject({ total: 2, withPolicy: 1, noPolicy: 1 });
  });

  it("a drifted provider row: red naming the provider", () => {
    const drifted = JSON.parse(JSON.stringify(coreRequiredSessionAdvertisement())) as RequiredSessionAdvertisement;
    (drifted.providerGroups as Record<string, readonly string[]>).opencode2 = ["bbPlugins", "nativePlugins"];
    const report = buildProfileReport({
      threads: [{ threadId: "w1", role: "writer", policyJson: JSON.stringify(writerPolicy()) }],
      agents: agents(drifted),
      now: NOW,
    });
    expect(report.red.some((line) => line.includes("opencode2"))).toBe(true);
    expect(report.providers.find((row) => row.provider === "opencode2")).toMatchObject({ ok: false });
  });

  it("no capability: red says requiredSessionPolicy «none», expected «required»", () => {
    const report = buildProfileReport({ threads: [], agents: agents(null), now: NOW });
    expect(report.requiredSessionPolicy).toBe("none");
    expect(report.red.some((line) => line.includes("requiredSessionPolicy"))).toBe(true);
  });

  it("a stored policy missing a profile skill counts as narrowed — stored presence, no ceiling attribution", () => {
    const cut = writerPolicy();
    (cut.policy.skills.names as string[]).splice(cut.policy.skills.names.indexOf("karpathy-guidelines"), 1);
    const report = buildProfileReport({
      threads: [
        { threadId: "w1", role: "writer", policyJson: JSON.stringify(writerPolicy()) },
        { threadId: "w2", role: "writer", policyJson: JSON.stringify(cut) },
      ],
      agents: agents(coreRequiredSessionAdvertisement()),
      now: NOW,
    });
    expect(report.narrowed).toBe(1);
    expect(report.red).toEqual([]);
    // The displayed count is qualified as stored policy — it never blames a parent ceiling or claims enforcement.
    const db = pluginDb();
    saveProfileCheck(db, report);
    const line = profileCheckMorningLine(db)!;
    expect(line).toContain("сохранённая политика уже профиля 1");
    expect(line).not.toContain("потолок");
  });
});

describe("helperThreadsViaSdk over the SDK facts", () => {
  it("reads only window helpers of the plugin by marker, not by role name", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const seen = { listArgs: [] as unknown[] };
    sdkThreads(harness, [
      // Probes and bench lanes leave by their markers even though they carry a counted role.
      { id: "probe-writer", role: "writer", probe: true },
      { id: "bench", role: "writer", bench: true },
      // A root thread is not a child helper even when it carries a role.
      { id: "root", role: "writer", parent: null },
      { id: "pm", role: "pm" },
      { id: "wp", role: "workspace-provisioner" },
      { id: "norole" },
      { id: "old", role: "pm", at: NOW - 30 * HOUR },
    ], seen);
    const rows = await helperThreadsViaSdk(bb as never, NOW - 24 * HOUR);
    // pm/provisioner return in the raw rows (rolePolicyCounts drops them); markers, roots, old and role-less do not.
    expect(rows.map((row) => row.threadId).sort()).toEqual(["pm", "wp"]);
    // Scoping is children-only with hidden included — deliberately no originPluginId: the old SQL keyed on the
    // lane-pilot metadata namespace, so a foreign-origin thread carrying it must stay in the window.
    expect(seen.listArgs[0]).toMatchObject({ hasParent: true, includeHidden: true });
    expect(seen.listArgs[0]).not.toHaveProperty("originPluginId");
  });

  it("a counted helper on a host without the inspection method is unsupported — the method is never requested", async () => {
    const seen = { listArgs: [] as unknown[], metaCalls: [] as { pluginId?: string; size: number }[] };
    const bb = bbWithoutInspect([
      { id: "w", role: "writer", policy: writerPolicy() },
      { id: "pm", role: "pm" },
    ], seen);
    await expect(helperThreadsViaSdk(bb, NOW - 24 * HOUR)).rejects.toThrow(/unsupported/);
    // No pluginId is ever sent: the plain threads API has no wrapper to fill one, and no __vk.* name can appear.
    expect(seen.metaCalls.length).toBeGreaterThan(0);
    expect(seen.metaCalls.every((c) => c.pluginId === undefined)).toBe(true);
  });

  it("asks the metadata API by chunks of at most 200 ids for the lane-pilot namespace", async () => {
    const seen = { listArgs: [] as unknown[], metaCalls: [] as { pluginId?: string; size: number }[] };
    const threads = Array.from({ length: 205 }, (_, i) => ({ id: `w${i}`, role: "writer", policy: writerPolicy() }));
    const bb = bbWithoutInspect(threads, seen);
    // Counted helpers exist but the host has no inspection method — the day is unsupported; the LP
    // metadata batch/page contract is still exercised on the way there.
    await expect(helperThreadsViaSdk(bb, NOW - 24 * HOUR)).rejects.toThrow(/unsupported/);
    // ceil(205/200) = 2 calls.
    expect(seen.metaCalls.map((c) => c.size)).toEqual([200, 5]);
    expect(seen.metaCalls.every((c) => c.pluginId === undefined)).toBe(true);
  });

  it("a malformed threads.list answer is unverified, never an empty success", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.list" as never, async () => ({ threads: [] }));
    harness.sdk.stub("threads.experimental_listPluginMetadata" as never, async () => ({ threads: [] }));
    await expect(helperThreadsViaSdk(bb as never, NOW - 24 * HOUR)).rejects.toThrow(/non-array/);
  });
});

describe("stored-policy inspection over the optional SDK method", () => {
  it("valid snapshots become policyJson, confirmed absent stays null — mixed day counts honestly", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    sdkThreads(harness, [
      { id: "w1", role: "writer", policy: writerPolicy() },
      { id: "w2", role: "writer" }, // no policy field → absent
      { id: "pm", role: "pm" }, // skipped role: never inspected
    ]);
    const seen = { calls: [] as number[] };
    sdkInspect(harness, [
      { id: "w1", role: "writer", policy: writerPolicy() },
      { id: "w2", role: "writer" },
      { id: "pm", role: "pm" },
    ], { seen });
    const rows = await helperThreadsViaSdk(bb as never, NOW - 24 * HOUR);
    const w1 = rows.find((row) => row.threadId === "w1")!;
    const w2 = rows.find((row) => row.threadId === "w2")!;
    expect(JSON.parse(w1.policyJson!)).toEqual({ policy: writerPolicy().policy });
    expect(w2.policyJson).toBeNull();
    // Only counted roles are sent: pm never reaches the inspection call.
    expect(seen.calls).toEqual([2]);
  });

  it("chunks inspection at 200 ids per call", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const threads = Array.from({ length: 201 }, (_, i) => ({ id: `w${i}`, role: "writer", policy: writerPolicy() }));
    sdkThreads(harness, threads);
    const seen = { calls: [] as number[] };
    sdkInspect(harness, threads, { seen });
    const rows = await helperThreadsViaSdk(bb as never, NOW - 24 * HOUR);
    expect(seen.calls).toEqual([200, 1]);
    expect(rows).toHaveLength(201);
    expect(rows.every((row) => row.policyJson !== null)).toBe(true);
  });

  // A well-formed v1 reply whose snapshot carries `policy` (and optionally `ceiling`) — for value-bound cases.
  const validReply = (ids: string[], policy: unknown, ceiling?: unknown) => ({
    version: 1,
    results: ids.map((id) => ({
      threadId: id,
      status: "valid",
      snapshot: { version: 1, policy, ...(ceiling === undefined ? {} : { ceiling }) },
    })),
  });
  const allowPolicy = (names: string[], extra: object = {}) => ({ skills: { mode: "allow", names, allOf: [], ...extra } });

  it.each([
    ["wrong version", () => ({ version: 2, results: [] })],
    ["length mismatch", (ids: string[]) => ({ version: 1, results: ids.slice(1).map((id) => ({ threadId: id, status: "absent" })) })],
    ["missing id", (ids: string[]) => ({ version: 1, results: ids.map((_, i) => ({ threadId: `ghost${i}`, status: "absent" })) })],
    ["duplicate id", (ids: string[]) => ({ version: 1, results: ids.map(() => ({ threadId: ids[0], status: "absent" })) })],
    ["unknown status", (ids: string[]) => ({ version: 1, results: ids.map((id) => ({ threadId: id, status: "bogus" })) })],
    ["unknown field", (ids: string[]) => ({ version: 1, results: ids.map((id) => ({ threadId: id, status: "absent", extra: 1 })) })],
    ["unparsable valid policy", (ids: string[]) => ({ version: 1, results: ids.map((id) => ({ threadId: id, status: "valid", snapshot: { version: 1, policy: "nope" } })) })],
    ["unknown top-level field", (ids: string[]) => ({ version: 1, results: ids.map((id) => ({ threadId: id, status: "absent" })), pluginId: "x" })],
    // Core value bounds (vk-session-policy.ts): the mirror must reject what the producer's own schema cannot emit.
    ["empty policy name", (ids: string[]) => validReply(ids, allowPolicy([""]))],
    ["whitespace-padded name", (ids: string[]) => validReply(ids, allowPolicy([" lp-writer "]))],
    ["overlong name", (ids: string[]) => validReply(ids, allowPolicy(["x".repeat(201)]))],
    ["501 names", (ids: string[]) => validReply(ids, allowPolicy(Array.from({ length: 501 }, (_, i) => `n${i}`)))],
    ["65 allOf clauses", (ids: string[]) => validReply(ids, { skills: { mode: "allow", names: ["lp-writer"], allOf: Array.from({ length: 65 }, () => ({ mode: "deny", names: [] })) } })],
    ["malformed ceiling", (ids: string[]) => validReply(ids, allowPolicy(["lp-writer"]), { skills: { mode: "allow", names: [""] } })],
    ["nested unknown field", (ids: string[]) => validReply(ids, allowPolicy(["lp-writer"], { extra: 1 }))],
  ])("a malformed inspection reply (%s) is unverified, never partial", async (_label, respond) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const threads = [
      { id: "w1", role: "writer", policy: writerPolicy() },
      { id: "w2", role: "writer", policy: writerPolicy() },
    ];
    sdkThreads(harness, threads);
    sdkInspect(harness, threads, { respond: respond as (ids: string[]) => unknown });
    await expect(helperThreadsViaSdk(bb as never, NOW - 24 * HOUR)).rejects.toThrow(/malformed|answered|repeated|missed/);
  });

  it.each([
    ["invalid digest_mismatch", { threadId: "w1", status: "invalid", reason: "digest_mismatch" }, /digest_mismatch/],
    ["invalid malformed_snapshot", { threadId: "w1", status: "invalid", reason: "malformed_snapshot" }, /malformed_snapshot/],
    ["invalid incomplete_snapshot", { threadId: "w1", status: "invalid", reason: "incomplete_snapshot" }, /incomplete_snapshot/],
    ["unavailable", { threadId: "w1", status: "unavailable" }, /unavailable/],
  ] as const)("a stored %s makes the day unverified with the reason named", async (_label, entry, pattern) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const threads = [{ id: "w1", role: "writer", inspect: entry }];
    sdkThreads(harness, threads);
    sdkInspect(harness, threads);
    await expect(helperThreadsViaSdk(bb as never, NOW - 24 * HOUR)).rejects.toThrow(pattern);
  });

  it("a rejected inspection call propagates — the day is unverified", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const threads = [{ id: "w1", role: "writer", policy: writerPolicy() }];
    sdkThreads(harness, threads);
    harness.sdk.stub("threads.experimental_vkInspectRequiredSessionPolicies" as never, async () => {
      throw new Error("operational failure");
    });
    await expect(helperThreadsViaSdk(bb as never, NOW - 24 * HOUR)).rejects.toThrow(/operational failure/);
  });

  it("core boundary values still validate: 200-char name, 500 names, 64 allOf clauses", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const boundaryPolicy = {
      skills: {
        mode: "allow",
        names: Array.from({ length: 500 }, (_, i) => `skill-${String(i).padStart(3, "0")}-${"x".repeat(186)}`),
        allOf: Array.from({ length: 64 }, () => ({ mode: "deny", names: ["y".repeat(200)] })),
      },
      mcpServers: { mode: "allow", names: ["z".repeat(200)], allOf: [] },
    };
    const threads = [{ id: "w1", role: "writer", inspect: { threadId: "w1", status: "valid", snapshot: { version: 1, policy: boundaryPolicy } } }];
    sdkThreads(harness, threads);
    sdkInspect(harness, threads);
    const rows = await helperThreadsViaSdk(bb as never, NOW - 24 * HOUR);
    expect(JSON.parse(rows[0]!.policyJson!)).toEqual({ policy: boundaryPolicy });
  });

  it("the recorded producer corpus maps: policy/ceiling stay distinct, prefix/deny/empty-allow and absent validate", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const threads = [
      { id: "w-ceiling", role: "writer", inspect: PRODUCER_CORPUS.validPolicyCeiling },
      { id: "w-prefix", role: "writer", inspect: PRODUCER_CORPUS.validPrefixDeny },
      { id: "w-absent", role: "writer", inspect: PRODUCER_CORPUS.absent },
    ];
    sdkThreads(harness, threads);
    sdkInspect(harness, threads);
    const rows = await helperThreadsViaSdk(bb as never, NOW - 24 * HOUR);
    // Only snapshot.policy reaches policyJson — the broader ceiling is never copied into the stored row.
    expect(JSON.parse(rows.find((row) => row.threadId === "w-ceiling")!.policyJson!))
      .toEqual({ policy: PRODUCER_CORPUS.validPolicyCeiling.snapshot.policy });
    expect(JSON.parse(rows.find((row) => row.threadId === "w-prefix")!.policyJson!))
      .toEqual({ policy: PRODUCER_CORPUS.validPrefixDeny.snapshot.policy });
    expect(rows.find((row) => row.threadId === "w-absent")!.policyJson).toBeNull();
    // Both valids are stored policies already below the writer profile; absent is the confirmed noPolicy.
    expect(rolePolicyCounts(rows).find((row) => row.role === "writer")).toMatchObject({ total: 3, withPolicy: 2, noPolicy: 1, narrowed: 2 });
  });

  it("corpus invalid/unavailable entries make the whole day unverified with bounded reasons", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const threads = [
      { id: "w-invalid", role: "writer", inspect: PRODUCER_CORPUS.invalidDigest },
      { id: "w-unavailable", role: "writer", inspect: PRODUCER_CORPUS.unavailable },
    ];
    sdkThreads(harness, threads);
    sdkInspect(harness, threads);
    await expect(helperThreadsViaSdk(bb as never, NOW - 24 * HOUR))
      .rejects.toThrow("stored policy unverified: 1 invalid:digest_mismatch, 1 unavailable");
  });

  it("a bad second chunk unverifieds the day even when the first 200 answered valid", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const threads = Array.from({ length: 201 }, (_, i) => ({
      id: `w${i}`,
      role: "writer",
      ...(i === 200
        ? { inspect: { threadId: "w200", status: "invalid", reason: "digest_mismatch" } }
        : { policy: writerPolicy() }),
    }));
    sdkThreads(harness, threads);
    sdkInspect(harness, threads);
    await expect(helperThreadsViaSdk(bb as never, NOW - 24 * HOUR)).rejects.toThrow(/digest_mismatch/);
  });

  it("a rejected second chunk propagates after a fully valid first chunk", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const threads = Array.from({ length: 201 }, (_, i) => ({ id: `w${i}`, role: "writer", policy: writerPolicy() }));
    sdkThreads(harness, threads);
    harness.sdk.stub("threads.experimental_vkInspectRequiredSessionPolicies" as never, async (args: { threadIds: string[] }) => {
      if (args.threadIds.length === 1) throw new Error("second chunk refused");
      return { version: 1, results: args.threadIds.map((id) => ({ threadId: id, status: "valid", snapshot: { version: 1, policy: writerPolicy().policy } })) };
    });
    await expect(helperThreadsViaSdk(bb as never, NOW - 24 * HOUR)).rejects.toThrow(/second chunk refused/);
  });
});

describe("narrowedByCeiling against core filter semantics", () => {
  const stored = (policy: object) => JSON.stringify({ policy });
  const allow = (names: string[], allOf: object[] = []) => ({ mode: "allow", names, allOf });
  const deny = (names: string[]) => ({ mode: "deny", names });
  // writer profile: skills [lp-writer, karpathy-guidelines], mcpServers [gitnexus].

  it("allOf allow subset narrows: a name the subset drops is lost", () => {
    const policy = { skills: allow(["lp-writer", "karpathy-guidelines"], [allow(["lp-writer"])]), mcpServers: allow(["gitnexus"]) };
    expect(narrowedByCeiling("writer", stored(policy))).toBe(true);
  });

  it("allOf deny naming a profile skill narrows", () => {
    const policy = { skills: allow(["lp-writer", "karpathy-guidelines"], [deny(["karpathy-guidelines"])]), mcpServers: allow(["gitnexus"]) };
    expect(narrowedByCeiling("writer", stored(policy))).toBe(true);
  });

  it("deny-only filter not naming a profile name does not narrow", () => {
    const policy = { skills: deny(["unrelated"]), mcpServers: allow(["gitnexus"]) };
    expect(narrowedByCeiling("writer", stored(policy))).toBe(false);
  });

  it("deny naming a profile name narrows", () => {
    const policy = { skills: deny(["lp-writer"]), mcpServers: allow(["gitnexus"]) };
    expect(narrowedByCeiling("writer", stored(policy))).toBe(true);
  });

  it("trailing-* prefix patterns match like the core", () => {
    expect(narrowedByCeiling("writer", stored({ skills: allow(["lp-*"]), mcpServers: allow(["gitnexus"]) }))).toBe(true); // karpathy-guidelines unmatched
    expect(narrowedByCeiling("writer", stored({ skills: allow(["*"]), mcpServers: allow(["gitnexus"]) }))).toBe(false);
  });

  it("empty allow narrows; an absent group is permissive like the core", () => {
    expect(narrowedByCeiling("writer", stored({ skills: allow([]), mcpServers: allow(["gitnexus"]) }))).toBe(true);
    expect(narrowedByCeiling("writer", stored({ mcpServers: allow(["gitnexus"]) }))).toBe(false);
  });

  it("unparsable policyJson fails closed as narrowed", () => {
    expect(narrowedByCeiling("writer", "{not-json")).toBe(true);
  });
});

describe("the check against an owner item", () => {
  /** A real plugin base (lane_pilot_owner_item, lane_pilot_profile_check) and the SDK facts stubbed on the fake host. `noInspect` swaps in a threads API without the optional method (old host). */
  function rig(threads: FixtureThread[], advertised: RequiredSessionAdvertisement | null = coreRequiredSessionAdvertisement(), opts?: { noInspect?: boolean }) {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const rows = [...threads];
    sdkThreads(harness, rows);
    const effectiveBb = opts?.noInspect ? { ...bb, sdk: { threads: threadsApiWithoutInspect(rows) } } : bb;
    (effectiveBb as { agents?: unknown }).agents = advertised === null ? {} : { experimental_vkRequiredSessionPolicy: () => advertised };
    const api = createProfileCheck({ db, bb: effectiveBb, log: () => undefined, isDisposed: () => false } as never).profileCheck;
    const ownerRow = () => db.prepare("SELECT state, why FROM lane_pilot_owner_item WHERE key=?").get(PROFILE_CHECK_OWNER_KEY) as { state: string; why: string } | undefined;
    return { api, rows, ownerRow, db };
  }

  it("counted helpers on a host without the inspection method: «не проверено», no owner item, no fabricated red", async () => {
    const { api, ownerRow, db } = rig([{ id: "w", role: "writer", policy: writerPolicy() }], coreRequiredSessionAdvertisement(), { noInspect: true });
    const report = await api.check(NOW);
    expect(report.unverified).toContain("unsupported");
    expect(report.red).toEqual([]);
    expect(ownerRow()).toBeUndefined();
    expect(profileCheckMorningLine(db as never)).toContain("не проверено");
  });

  it("a confirmed absent stored policy is red noPolicy — never green", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const rows = [{ id: "w", role: "writer" }];
    sdkThreads(harness, rows);
    sdkInspect(harness, rows); // no policy field → absent
    (bb as { agents?: unknown }).agents = { experimental_vkRequiredSessionPolicy: () => coreRequiredSessionAdvertisement() };
    const api = createProfileCheck({ db, bb, log: () => undefined, isDisposed: () => false } as never).profileCheck;
    const report = await api.check(NOW);
    expect(report.unverified).toBeNull();
    expect(report.noPolicy).toBe(1);
    expect(report.red.some((line) => line.includes("writer"))).toBe(true);
  });

  it("only non-counted roles keep a valid empty count — green, no owner item", async () => {
    const { api, ownerRow } = rig([
      { id: "pm", role: "pm" },
      { id: "wp", role: "workspace-provisioner" },
      { id: "probe", role: "writer", probe: true },
    ]);
    const report = await api.check(NOW);
    expect(report.unverified).toBeNull();
    expect(report.red).toEqual([]);
    expect(report.threads).toBe(0);
    expect(ownerRow()?.state ?? "closed").toBe("closed");
  });

  it("an SDK read the host cannot serve is «не проверено»: report saved, no owner item", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    harness.sdk.stub("threads.list" as never, async () => { throw new Error("no such method"); });
    const api = createProfileCheck({ db, bb, log: () => undefined, isDisposed: () => false } as never).profileCheck;
    const report = await api.check(NOW);
    expect(report.unverified).not.toBeNull();
    expect(report.red).toEqual([]);
    expect(db.prepare("SELECT state FROM lane_pilot_owner_item WHERE key=?").get(PROFILE_CHECK_OWNER_KEY)).toBeUndefined();
    expect(profileCheckMorningLine(db as never)).toContain("не проверено");
  });
});

describe("the stored report and the morning line", () => {
  it("null before the first check, one line after — red facts are named in it", () => {
    const db = pluginDb();
    expect(profileCheckMorningLine(db)).toBeNull();
    expect(latestProfileCheck(db)).toBeNull();
    const report = buildProfileReport({
      threads: [{ threadId: "w2", role: "writer", policyJson: null }],
      agents: agents(coreRequiredSessionAdvertisement()),
      now: NOW,
    });
    saveProfileCheck(db, report);
    expect(latestProfileCheck(db)).toMatchObject({ noPolicy: 1 });
    const line = profileCheckMorningLine(db);
    expect(line).toContain("КРАСНОЕ");
    expect(line).toContain("writer");
  });
});
