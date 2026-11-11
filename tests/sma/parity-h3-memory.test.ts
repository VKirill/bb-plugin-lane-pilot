import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import {
  dropMemoryIndexes, hideRecord, lintMemory, storeMemoryRecords,
} from "../../packages/memory-core/src";
import { memoryContentIssue } from "../../packages/memory-core/src/candidates";
import { CREDENTIAL_SHAPE_PATTERNS, maskCredentials } from "@lane-pilot/kit";
import type { MemoryCandidate, MemoryDatabase } from "../../packages/memory-core/src";
import { createMemoryConflicts } from "../../src/rooms/memory/server/memory-conflicts";
import { createFront } from "../../src/rooms/front/server/index";
import { peerLine } from "../../src/rooms/front/logic";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import type { Services } from "../../server";

const newHost = () => createFakePluginHost({ pluginId: "lane-pilot" });
const BUDGETS = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 };
const put = (db: MemoryDatabase, entries: MemoryCandidate[], projectId = "P") =>
  storeMemoryRecords(db, { projectId, sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", entries, ...BUDGETS }).insertedIds;
const note = (content: string, concepts: string[] = ["area"]): MemoryCandidate => ({ kind: "note", content, concepts });
const fileNote = (content: string, sourceFileId = "file1"): MemoryCandidate => ({ kind: "note", content, concepts: ["area"], sourceFileId });
const row = (db: MemoryDatabase, id: string) => db.prepare("SELECT status, expired_reason AS reason FROM lane_pilot_memory WHERE id=?").get(id) as { status: string; reason: string | null } | undefined;
const unindexer = (db: MemoryDatabase) => (p: string, id: string) => dropMemoryIndexes(db, p, id);

type ThreadSpec = { projectId: string; role?: string };
/** The real `bb lane-pilot memory …` CLI on a scratch database; `threads` says who a calling thread id is (project and plugin role). */
function cliHarness(threads: Record<string, ThreadSpec> = {}) {
  const host = newHost();
  const db = openDatabase(host.bb);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threads[threadId] ? { id: threadId, projectId: threads[threadId]!.projectId } : null);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threads[threadId]?.role ? { role: threads[threadId]!.role } : null);
  const memoryConflicts = createMemoryConflicts({ db, deferrals: () => ({ close: () => {} }) });
  registerCli(createCore(host.bb, db), { memoryConflicts } as unknown as Services, migrations);
  const run = (argv: string[], threadId?: string) => host.harness.behavior.runCli(["memory", ...argv], threadId ? { threadId } : {});
  return { host, db, run };
}

describe("memory parity h3", () => {
  it("[sma:m_lifecycle] an owner tombstone (`owner` reason, or `--replace`'s supersede) never revives — not restated, not re-imported from its file; idle, dated and an automatic supersede still come back", () => {
    const db = openDatabase(newHost().bb);
    const unindex = unindexer(db);
    // Owner-expired: a restatement does not bring it back.
    const gone = "The billing queue holds refunds for three days.";
    const [ownerExpired, idle, dated] = put(db, [note(gone), note("The billing queue holds chargebacks for three days."), note("The billing queue holds payouts for three days.")]);
    hideRecord(db, "P", ownerExpired!, "expired", null, unindex, "owner");
    hideRecord(db, "P", idle!, "expired", null, unindex, "idle");
    hideRecord(db, "P", dated!, "expired", null, unindex, "dated");
    const restated = put(db, [note(gone), note("The billing queue holds chargebacks for three days."), note("The billing queue holds payouts for three days.")].map((entry, i) => ({ ...entry, concepts: [`t${i}`] })));
    expect(restated.sort()).toEqual([idle, dated].sort());
    expect(row(db, ownerExpired!)).toEqual({ status: "expired", reason: "owner" });
    // --replace's tombstone: a superseded row marked owner is not revived by a re-import of the file it came from.
    const [replaced, keeper] = put(db, [fileNote("The nightly export lives in the exports folder."), fileNote("The weekly digest goes out on Monday.", "other")]);
    hideRecord(db, "P", replaced!, "superseded", keeper!, unindex, "owner");
    expect(put(db, [fileNote("The nightly export lives in the exports folder.")])).toEqual([]);
    expect(row(db, replaced!)).toEqual({ status: "superseded", reason: "owner" });
    // An automatic supersede (no owner mark) still revives when its file says the fact again.
    const [auto, keeper2] = put(db, [fileNote("The monthly invoice runs on the first.", "auto1"), fileNote("The quarterly report ships Friday.", "auto2")]);
    hideRecord(db, "P", auto!, "superseded", keeper2!, unindex);
    expect(put(db, [fileNote("The monthly invoice runs on the first.", "auto1")])).toEqual([auto]);
    expect(row(db, auto!)?.status).toBe("active");
    expect(keeper).toBeTruthy();
  });

  it("[sma:k_v_mem_forget] --expire stores its own `owner` reason and --replace leaves a tombstone: neither a restatement nor a re-import of the file revives them", async () => {
    const h = cliHarness();
    const [expired, replaced, keeper, fileRec, fileKeeper] = put(h.db, [
      note("Alpha is a distinct fact about the billing ledger rounding.", ["alpha"]),
      note("Delta is a distinct fact about the billing ledger rounding.", ["delta"]),
      note("Epsilon is a distinct fact about the billing ledger rounding.", ["epsilon"]),
      fileNote("The nightly export lives in the exports folder."),
      fileNote("The weekly digest goes out on Monday.", "keeper"),
    ]);
    const forget = (...argv: string[]) => h.run(["forget", ...argv, "--project", "P"]);
    expect((await forget(expired!, "--expire")).exitCode).toBe(0);
    expect((await forget(replaced!, "--replace", keeper!)).exitCode).toBe(0);
    expect((await forget(fileRec!, "--replace", fileKeeper!)).exitCode).toBe(0);
    expect(row(h.db, expired!)).toEqual({ status: "expired", reason: "owner" });
    expect(row(h.db, replaced!)).toEqual({ status: "superseded", reason: "owner" });
    // Restated: nothing comes back. Re-imported from its file: nothing comes back either.
    expect(put(h.db, [note("Alpha is a distinct fact about the billing ledger rounding.", ["alpha"])])).toEqual([]);
    expect(put(h.db, [note("Delta is a distinct fact about the billing ledger rounding.", ["delta"])])).toEqual([]);
    expect(put(h.db, [fileNote("The nightly export lives in the exports folder.")])).toEqual([]);
    expect(row(h.db, expired!)).toEqual({ status: "expired", reason: "owner" });
    expect(row(h.db, replaced!)).toEqual({ status: "superseded", reason: "owner" });
    expect(row(h.db, fileRec!)).toEqual({ status: "superseded", reason: "owner" });
  });

  it("[sma:k_lib_lint] the lint report is the tiered checks in one stable order — error before warn before info — and the same corpus gives the same report twice", () => {
    const db = openDatabase(newHost().bb);
    const [a, b, c] = put(db, [note("Alpha fact about the billing ledger."), note("Beta fact about the refund queue."), note("Gamma fact about the audit trail.")]);
    // Planted rows the write door would refuse today: a credential (error), a record past its date (warn), an idle note (info).
    db.prepare("UPDATE lane_pilot_memory SET content=? WHERE id=?").run("password: hunter2xx lives here", a!);
    db.prepare("UPDATE lane_pilot_memory SET valid_until=? WHERE id=?").run(1, b!);
    db.prepare("UPDATE lane_pilot_memory SET created_at=? WHERE id=?").run(Date.now() - 91 * 86_400_000, c!);
    const first = lintMemory(db, "P");
    const second = lintMemory(db, "P");
    expect(first).toEqual(second);
    expect(first.find((item) => item.check === "secret")).toMatchObject({ tier: "error", recordId: a });
    expect(first.find((item) => item.check === "dated")).toMatchObject({ tier: "warn", recordId: b });
    expect(first.find((item) => item.check === "idle")).toMatchObject({ tier: "info", recordId: c });
    const order = { error: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < first.length; i++) expect(order[first[i]!.tier]).toBeGreaterThanOrEqual(order[first[i - 1]!.tier]);
  });

  it("[sma:k_lib_secretsmask] the memory refusal is the shared mask's shape table: every shape the mask masks is refused, and what the mask alone eats (`GITHUB_TOKEN: …` prose) still stores", () => {
    const KEY = `sk-${"a".repeat(24)}`;
    for (const text of [
      `key ${KEY}`, `Authorization: Bearer ${"b".repeat(24)}`, "-----BEGIN RSA PRIVATE KEY-----",
      `jwt eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`, "password: hunter22", "API_KEY=abc12345",
    ]) expect(memoryContentIssue(text), text).toContain("credential");
    // One table: the refusal and the mask read the same shape list, so a new shape masks and refuses together.
    expect(maskCredentials(`key ${KEY}`).masked).toBe(true);
    expect(CREDENTIAL_SHAPE_PATTERNS.length).toBeGreaterThan(0);
    // The mask's own keyed rule masks it, but the refusal leaves ordinary prose and this assignment alone, as before.
    for (const text of ["GITHUB_TOKEN: needed for release", "We rotate the API key monthly", "secret correcthorse"])
      expect(memoryContentIssue(text), text).toBeNull();
    expect(maskCredentials("GITHUB_TOKEN: needed for release").text).toContain("***");
  });

  it("[sma:m_mc_poll] a peer that answers with no windows reads answered:true and its line says «нет окон»; only a failed call reads answered:false and «доска не ответила»", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    harness.sdk.stub("hosts.list", async () => [{ id: "h1", name: "one", status: "connected" }, { id: "h2", name: "two", status: "connected" }, { id: "h3", name: "three", status: "connected" }]);
    const api = createFront({ db, bb, log: () => undefined, isDisposed: () => false } as never, {
      board: (id: string) => id === "h3" ? Promise.reject(new Error("down"))
        : Promise.resolve(id === "h1" ? { at: new Date().toISOString(), windows: { five_hour: { utilization: 42, resetsAt: null } } } : { at: null, windows: {} }),
    }).front;
    const rows = await api.pollPeers();
    const h1 = rows.find((row) => row.hostId === "h1")!;
    const h2 = rows.find((row) => row.hostId === "h2")!;
    const h3 = rows.find((row) => row.hostId === "h3")!;
    expect(h1.answered).toBe(true);
    expect(h2.answered).toBe(true);      // answered with an empty board: silent no longer
    expect(h3.answered).toBe(false);     // only a failed call is silence
    expect(peerLine(h1)).toContain("five_hour 42%");
    expect(peerLine(h2)).toContain("нет окон");
    expect(peerLine(h3)).toContain("доска не ответила");
    await harness.lifecycle.dispose();
  });
});
